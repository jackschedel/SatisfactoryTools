import { DataSet } from 'vis-network';
import { IVisNode } from '@src/Tools/Production/Result/IVisNode';
import { IVisEdge } from '@src/Tools/Production/Result/IVisEdge';
import { ILinkNodeDescriptor } from '@src/Tools/Production/IProductionData';
import { ProductionResult } from '@src/Tools/Production/Result/ProductionResult';
import { RecipeNode } from '@src/Tools/Production/Result/Nodes/RecipeNode';
import { RecipeData } from '@src/Tools/Production/Result/RecipeData';
import { MachineGroup } from '@src/Tools/Production/Result/MachineGroup';
import model from '@src/Data/Model';
import { Strings } from '@src/Utils/Strings';
import { Numbers } from '@src/Utils/Numbers';
import { ICustomGraphState, ISplitDescriptor, ISplitGroup } from './types';
import { getNodeKey, getNodeDisplayName } from './nodeUtils';
import { createLinkPair, applyStoredSplitEdgeLink } from './linkOperations';
import { combineLinksGroup, uncombineCombinedGroup, countVisEdgesForSplitEligibility } from './combinedLinkOperations';

export function splitRecipeByOutput(
	state: ICustomGraphState,
	nodeId: number,
	recipeNode: RecipeNode,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
	itemToSplit?: string,
): void {
	splitRecipeByDirection(state, nodeId, recipeNode, nodes, edges, result, 'output', itemToSplit);
}

export function splitRecipeByInput(
	state: ICustomGraphState,
	nodeId: number,
	recipeNode: RecipeNode,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
	itemToSplit?: string,
): void {
	splitRecipeByDirection(state, nodeId, recipeNode, nodes, edges, result, 'input', itemToSplit);
}

export function splitRecipeByDirection(
	state: ICustomGraphState,
	nodeId: number,
	recipeNode: RecipeNode,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
	splitType: 'output' | 'input',
	itemToSplit?: string,
): void {
	const isOutput = splitType === 'output';

	const allDirectionalEdges = result.graph.edges.filter(
		(e) => (isOutput ? e.from.id : e.to.id) === nodeId,
	);

	if (!itemToSplit) {
		const itemEdgeCount: { [item: string]: number } = {};
		for (const e of allDirectionalEdges) {
			const edgeCount = countVisEdgesForSplitEligibility(state, e, isOutput);
			itemEdgeCount[e.itemAmount.item] =
				(itemEdgeCount[e.itemAmount.item] || 0) + edgeCount;
		}
		const candidates = Object.keys(itemEdgeCount).filter(
			(item) => itemEdgeCount[item] >= 2,
		);
		if (candidates.length === 0) {
			return;
		}
		itemToSplit = candidates[0];
	}

	const splitEdges = allDirectionalEdges.filter(
		(e) => e.itemAmount.item === itemToSplit,
	);
	let effectiveSplitEdgeCount = 0;
	for (const e of splitEdges) {
		effectiveSplitEdgeCount += countVisEdgesForSplitEligibility(state, e, isOutput);
	}
	if (effectiveSplitEdgeCount <= 1) {
		return;
	}

	if (state.splitGroups.some((g) => g.originalNodeId === nodeId)) {
		return;
	}

	const recipeKey = getNodeKey(recipeNode);

	const removedCombinedGroupInfos: {
		type: 'out' | 'in';
		combinedOutPos?: { x: number; y: number };
		combinedInPos?: { x: number; y: number };
		descriptors: ILinkNodeDescriptor[];
	}[] = [];
	for (let i = state.combinedLinkGroups.length - 1; i >= 0; i--) {
		const combinedGroup = state.combinedLinkGroups[i];
		const involvesRecipe = combinedGroup.originalPairs.some(
			(p) =>
				p.descriptor.fromNodeKey === recipeKey ||
				p.descriptor.toNodeKey === recipeKey,
		);
		if (involvesRecipe) {
			const cgPos = state.network.getPositions([
				combinedGroup.combinedOutId,
				combinedGroup.combinedInId,
			]);
			removedCombinedGroupInfos.push({
				type: combinedGroup.type,
				combinedOutPos: cgPos[combinedGroup.combinedOutId],
				combinedInPos: cgPos[combinedGroup.combinedInId],
				descriptors: combinedGroup.originalPairs.map((p) => ({ ...p.descriptor })),
			});
			uncombineCombinedGroup(state, i, nodes, edges, result);
		}
	}

	interface IRemovedLinkInfo {
		descriptor: ILinkNodeDescriptor;
		linkOutPos?: { x: number; y: number };
		linkInPos?: { x: number; y: number };
		combinedGroupIndex?: number;
	}
	const removedLinkInfos: IRemovedLinkInfo[] = [];

	for (let i = state.linkPairs.length - 1; i >= 0; i--) {
		const pair = state.linkPairs[i];
		if (
			pair.descriptor.fromNodeKey === recipeKey ||
			pair.descriptor.toNodeKey === recipeKey
		) {
			const linkPositions = state.network.getPositions([
				pair.linkOutId,
				pair.linkInId,
			]);

			let cgIdx: number | undefined;
			for (let ci = 0; ci < removedCombinedGroupInfos.length; ci++) {
				if (
					removedCombinedGroupInfos[ci].descriptors.some(
						(d) =>
							d.fromNodeKey === pair.descriptor.fromNodeKey &&
							d.toNodeKey === pair.descriptor.toNodeKey &&
							d.itemClassName === pair.descriptor.itemClassName,
					)
				) {
					cgIdx = ci;
					break;
				}
			}

			removedLinkInfos.push({
				descriptor: { ...pair.descriptor },
				linkOutPos: linkPositions[pair.linkOutId],
				linkInPos: linkPositions[pair.linkInId],
				combinedGroupIndex: cgIdx,
			});

			edges.remove(pair.outEdgeId);
			edges.remove(pair.inEdgeId);
			nodes.remove(pair.linkOutId);
			nodes.remove(pair.linkInId);
			edges.add(pair.originalEdgeData);
			state.linkPairs.splice(i, 1);
		}
	}

	const allVisEdges = getVisEdgesForNode(nodeId, edges);

	type VisEdgeResolution = {
		visEdge: any;
		graphEdge: any;
		splitGroup: ISplitGroup | null;
		splitNodeIndex: number;
	};

	const splitItemGraphEdgeIds = new Set(splitEdges.map((e) => e.id));
	const visEdgeResolutions: VisEdgeResolution[] = [];
	for (const visEdge of allVisEdges) {
		const resolved = resolveVisEdgeToGraphEdge(state, visEdge, nodeId, result);
		if (resolved) {
			visEdgeResolutions.push({
				visEdge: visEdge,
				graphEdge: resolved.graphEdge,
				splitGroup: resolved.splitGroup,
				splitNodeIndex: resolved.splitNodeIndex,
			});
		}
	}

	const graphEdgeGroupMap = new Map<number, VisEdgeResolution[]>();
	for (const res of visEdgeResolutions) {
		const geId = res.graphEdge.id as number;
		if (!graphEdgeGroupMap.has(geId)) {
			graphEdgeGroupMap.set(geId, []);
		}
		graphEdgeGroupMap.get(geId)!.push(res);
	}

	type GraphEdgeGroup = {
		graphEdge: any;
		resolutions: VisEdgeResolution[];
	};
	const primaryGroups: GraphEdgeGroup[] = [];
	const otherSameDirGroups: GraphEdgeGroup[] = [];
	const oppositeDirGroups: GraphEdgeGroup[] = [];

	graphEdgeGroupMap.forEach((resolutions, geId) => {
		const graphEdge = resolutions[0].graphEdge;
		const isSplitDir = isOutput
			? graphEdge.from.id === nodeId
			: graphEdge.to.id === nodeId;

		const edgeGroup: GraphEdgeGroup = { graphEdge: graphEdge, resolutions: resolutions };
		if (isSplitDir && splitItemGraphEdgeIds.has(geId)) {
			primaryGroups.push(edgeGroup);
		} else if (isSplitDir) {
			otherSameDirGroups.push(edgeGroup);
		} else {
			oppositeDirGroups.push(edgeGroup);
		}
	});

	const originalNodeData = nodes.get(nodeId);
	if (!originalNodeData) {
		return;
	}

	const originalEdgesData = allVisEdges.map((e: any) => ({ ...e }));

	const positions = state.network.getPositions([nodeId]);
	const originalPos = positions[nodeId] || { x: 0, y: 0 };

	const descriptor: ISplitDescriptor = {
		recipeNodeKey: recipeKey,
		splitType: splitType,
		splitItemClassName: itemToSplit,
	};

	const splitNodeIds: number[] = [];
	const splitEdgeIds: number[] = [];

	const totalAmount = splitEdges.reduce(
		(sum, e) => sum + e.itemAmount.amount,
		0,
	);

	const splitEntries: {
		graphEdge: any;
		resolutions: VisEdgeResolution[];
		amount: number;
		otherSplitGroup: ISplitGroup | null;
		otherSplitNodeIndex: number;
	}[] = [];

	for (const primaryGroup of primaryGroups) {
		const splitResolutions = primaryGroup.resolutions.filter(
			(r) => r.splitGroup !== null,
		);

		if (
			splitResolutions.length > 0 &&
			splitResolutions.length === primaryGroup.resolutions.length
		) {
			for (const res of splitResolutions) {
				const otherFraction = getSplitNodeFraction(
					res.splitGroup!,
					res.splitNodeIndex,
					result,
				);
				splitEntries.push({
					graphEdge: primaryGroup.graphEdge,
					resolutions: [res],
					amount: primaryGroup.graphEdge.itemAmount.amount * otherFraction,
					otherSplitGroup: res.splitGroup,
					otherSplitNodeIndex: res.splitNodeIndex,
				});
			}
		} else {
			splitEntries.push({
				graphEdge: primaryGroup.graphEdge,
				resolutions: primaryGroup.resolutions,
				amount: primaryGroup.graphEdge.itemAmount.amount,
				otherSplitGroup: null,
				otherSplitNodeIndex: -1,
			});
		}
	}

	for (const visEdge of allVisEdges) {
		edges.remove(visEdge.id);
	}
	nodes.remove(nodeId);

	const splitFractions: number[] = [];
	for (let i = 0; i < splitEntries.length; i++) {
		const entry = splitEntries[i];
		const splitNodeId = state.nextSplitNodeId();
		splitNodeIds.push(splitNodeId);

		const offsetY = (i - (splitEntries.length - 1) / 2) * 120;

		const fraction =
			totalAmount > 0 ? entry.amount / totalAmount : 1 / splitEntries.length;
		splitFractions.push(fraction);
		const splitAmount = recipeNode.recipeData.amount * fraction;

		const splitLabel =
			'<b>Split ' +
			recipeNode.recipeData.recipe.name +
			'</b>\n' +
			Strings.formatNumber(splitAmount) +
			'x ' +
			recipeNode.recipeData.machine.name +
			'\n<i>' +
			recipeNode.recipeData.clockSpeed +
			'% clock speed</i>';

		const titleEl = buildSplitNodeTooltip(recipeNode, splitAmount);

		nodes.add({
			id: splitNodeId,
			label: splitLabel,
			title: titleEl as unknown as string,
			x: originalPos.x,
			y: originalPos.y + offsetY,
			color: {
				border: 'rgba(0, 0, 0, 0)',
				background: 'rgba(180, 85, 20, 1)',
				highlight: {
					border: 'rgba(238, 238, 238, 1)',
					background: 'rgba(195, 100, 35, 1)',
				},
			},
			font: {
				color: 'rgba(238, 238, 238, 1)',
			},
		});

		for (const res of entry.resolutions) {
			const primaryEdge = res.visEdge;
			const splitPrimaryEdgeId = state.nextSplitEdgeId();
			splitEdgeIds.push(splitPrimaryEdgeId);
			edges.add({
				id: splitPrimaryEdgeId,
				from: isOutput ? splitNodeId : primaryEdge.from,
				to: isOutput ? primaryEdge.to : splitNodeId,
				label: primaryEdge.label || '',
				color: primaryEdge.color || {
					color: 'rgba(105, 125, 145, 1)',
					highlight: 'rgba(134, 151, 167, 1)',
				},
				font: primaryEdge.font || {
					color: 'rgba(238, 238, 238, 1)',
				},
				smooth: primaryEdge.smooth,
			} as any);
		}

		for (const oppGroup of oppositeDirGroups) {
			for (const res of oppGroup.resolutions) {
				const edgeId = state.nextSplitEdgeId();
				splitEdgeIds.push(edgeId);
				let baseMultiplier: number | undefined;
				if (res.splitGroup) {
					baseMultiplier = getSplitNodeFraction(
						res.splitGroup,
						res.splitNodeIndex,
						result,
					);
				}
				edges.add(
					buildScaledSplitEdge(
						edgeId,
						res.visEdge,
						splitNodeId,
						fraction,
						result,
						!isOutput,
						res.graphEdge,
						baseMultiplier,
					),
				);
			}
		}

		for (const otherGroup of otherSameDirGroups) {
			for (const res of otherGroup.resolutions) {
				const edgeId = state.nextSplitEdgeId();
				splitEdgeIds.push(edgeId);
				let baseMultiplier: number | undefined;
				if (res.splitGroup) {
					baseMultiplier = getSplitNodeFraction(
						res.splitGroup,
						res.splitNodeIndex,
						result,
					);
				}
				edges.add(
					buildScaledSplitEdge(
						edgeId,
						res.visEdge,
						splitNodeId,
						fraction,
						result,
						isOutput,
						res.graphEdge,
						baseMultiplier,
					),
				);
			}
		}
	}

	const group: ISplitGroup = {
		originalNodeId: nodeId,
		originalNodeData: originalNodeData,
		originalEdgesData: originalEdgesData,
		splitNodeIds: splitNodeIds,
		splitEdgeIds: splitEdgeIds,
		descriptor: descriptor,
	};

	state.splitGroups.push(group);

	if (removedLinkInfos.length > 0) {
		recreateLinksOnSplitEdges(
			state,
			removedLinkInfos,
			group,
			splitFractions,
			splitEntries.map((e) => ({
				graphEdge: e.graphEdge,
				otherSplitGroup: e.otherSplitGroup,
				otherSplitNodeIndex: e.otherSplitNodeIndex,
			})),
			itemToSplit!,
			isOutput,
			nodes,
			edges,
			result,
			recipeKey,
			removedCombinedGroupInfos,
		);
	}

	state.saveGraphState();
}

function recreateLinksOnSplitEdges(
	state: ICustomGraphState,
	removedLinkInfos: {
		descriptor: ILinkNodeDescriptor;
		linkOutPos?: { x: number; y: number };
		linkInPos?: { x: number; y: number };
		combinedGroupIndex?: number;
	}[],
	group: ISplitGroup,
	splitFractions: number[],
	splitNodeInfos: {
		graphEdge: any;
		otherSplitGroup: ISplitGroup | null;
		otherSplitNodeIndex: number;
	}[],
	splitItem: string,
	isOutput: boolean,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
	recipeKey: string,
	removedCombinedGroupInfos: {
		type: 'out' | 'in';
		combinedOutPos?: { x: number; y: number };
		combinedInPos?: { x: number; y: number };
		descriptors: ILinkNodeDescriptor[];
	}[],
): void {
	const combinedGroupPairsMap = new Map<number, any[]>();

	for (const info of removedLinkInfos) {
		const isFromRecipe = info.descriptor.fromNodeKey === recipeKey;
		const isInSplitDirection = isOutput ? isFromRecipe : !isFromRecipe;
		const isOnSplitItem = info.descriptor.itemClassName === splitItem;

		const otherKey = isFromRecipe
			? info.descriptor.toNodeKey
			: info.descriptor.fromNodeKey;
		const otherGraphNode = result.graph.nodes.find(
			(n) => getNodeKey(n) === otherKey,
		);
		if (!otherGraphNode) {
			continue;
		}

		const graphEdge = result.graph.edges.find(
			(e) =>
				getNodeKey(e.from) === info.descriptor.fromNodeKey &&
				getNodeKey(e.to) === info.descriptor.toNodeKey &&
				e.itemAmount.item === info.descriptor.itemClassName,
		);
		if (!graphEdge) {
			continue;
		}

		const recreatedPairs: any[] = [];

		for (let si = 0; si < group.splitNodeIds.length; si++) {
			const splitNodeId = group.splitNodeIds[si];

			if (isInSplitDirection && isOnSplitItem) {
				const nodeInfo = splitNodeInfos[si];
				const pe = nodeInfo.graphEdge;
				const peTarget = isOutput ? pe.to.id : pe.from.id;
				if (peTarget !== otherGraphNode.id) {
					continue;
				}
				if (nodeInfo.otherSplitGroup && info.descriptor.splitRecipeKey) {
					if (
						nodeInfo.otherSplitGroup.descriptor.recipeNodeKey ===
							info.descriptor.splitRecipeKey &&
						nodeInfo.otherSplitNodeIndex !== info.descriptor.splitNodeIndex
					) {
						continue;
					}
				}
			}

			const fraction = splitFractions[si];

			let resolvedOtherVisId = otherGraphNode.id;
			if (
				info.descriptor.splitRecipeKey != null &&
				info.descriptor.splitNodeIndex != null
			) {
				const otherSplitGrp = state.splitGroups.find(
					(g) =>
						g.descriptor.recipeNodeKey === info.descriptor.splitRecipeKey,
				);
				if (
					otherSplitGrp &&
					info.descriptor.splitNodeIndex! < otherSplitGrp.splitNodeIds.length
				) {
					resolvedOtherVisId =
						otherSplitGrp.splitNodeIds[info.descriptor.splitNodeIndex!];
				}
			}

			const scaledAmount =
				isInSplitDirection && isOnSplitItem
					? splitNodeInfos[si].graphEdge.itemAmount.amount *
					  (splitNodeInfos[si].otherSplitGroup
							? getSplitNodeFraction(
									splitNodeInfos[si].otherSplitGroup!,
									splitNodeInfos[si].otherSplitNodeIndex,
									result,
							  )
							: 1)
					: graphEdge.itemAmount.amount * fraction;

			const splitEdge = findSplitEdgeForLink(
				splitNodeId,
				resolvedOtherVisId,
				isFromRecipe,
				info.descriptor.itemClassName,
				group,
				edges,
			);
			if (!splitEdge) {
				continue;
			}

			const fromId = isFromRecipe ? splitNodeId : resolvedOtherVisId;
			const toId = isFromRecipe ? resolvedOtherVisId : splitNodeId;
			const posMap = state.network.getPositions([fromId, toId]);
			const fromPos = posMap[fromId] || { x: 0, y: 0 };
			const toPos = posMap[toId] || { x: 0, y: 0 };

			const splitNodeData = nodes.get(splitNodeId);
			const splitName = splitNodeData
				? ((splitNodeData.label || '') as string)
						.replace(/<[^>]*>/g, '')
						.split('\n')[0]
						.trim() || 'Split Node'
				: 'Split Node';
			const otherNodeData = nodes.get(resolvedOtherVisId);
			const otherName =
				resolvedOtherVisId !== otherGraphNode.id && otherNodeData
					? ((otherNodeData.label || '') as string)
							.replace(/<[^>]*>/g, '')
							.split('\n')[0]
							.trim() || getNodeDisplayName(otherGraphNode)
					: getNodeDisplayName(otherGraphNode);

			const newDesc: ILinkNodeDescriptor = {
				fromNodeKey: info.descriptor.fromNodeKey,
				toNodeKey: info.descriptor.toNodeKey,
				itemClassName: info.descriptor.itemClassName,
				splitRecipeKey: recipeKey,
				splitNodeIndex: si,
			};
			if (info.descriptor.splitRecipeKey != null) {
				newDesc.otherSplitRecipeKey = info.descriptor.splitRecipeKey;
				newDesc.otherSplitNodeIndex = info.descriptor.splitNodeIndex;
			} else if (splitNodeInfos[si].otherSplitGroup) {
				newDesc.otherSplitRecipeKey =
					splitNodeInfos[si].otherSplitGroup!.descriptor.recipeNodeKey;
				newDesc.otherSplitNodeIndex = splitNodeInfos[si].otherSplitNodeIndex;
			}

			const pair = createLinkPair(
				state,
				nodes,
				edges,
				fromId,
				toId,
				splitEdge,
				newDesc,
				info.descriptor.itemClassName,
				scaledAmount,
				fromPos,
				toPos,
				isFromRecipe ? splitName : otherName,
				isFromRecipe ? otherName : splitName,
			);

			recreatedPairs.push(pair);
		}

		if (info.combinedGroupIndex != null) {
			const existing =
				combinedGroupPairsMap.get(info.combinedGroupIndex) || [];
			existing.push(...recreatedPairs);
			combinedGroupPairsMap.set(info.combinedGroupIndex, existing);
		} else {
			if (recreatedPairs.length >= 2) {
				const combineType: 'out' | 'in' = isFromRecipe ? 'out' : 'in';
				combineLinksGroup(
					state,
					recreatedPairs,
					combineType,
					nodes,
					edges,
					result,
				);

				const lastGroup =
					state.combinedLinkGroups[state.combinedLinkGroups.length - 1];
				if (lastGroup && info.linkOutPos) {
					nodes.update({
						id: lastGroup.combinedOutId,
						x: info.linkOutPos.x,
						y: info.linkOutPos.y,
					});
				}
				if (lastGroup && info.linkInPos) {
					nodes.update({
						id: lastGroup.combinedInId,
						x: info.linkInPos.x,
						y: info.linkInPos.y,
					});
				}
			} else if (recreatedPairs.length === 1) {
				if (info.linkOutPos) {
					nodes.update({
						id: recreatedPairs[0].linkOutId,
						x: info.linkOutPos.x,
						y: info.linkOutPos.y,
					});
				}
				if (info.linkInPos) {
					nodes.update({
						id: recreatedPairs[0].linkInId,
						x: info.linkInPos.x,
						y: info.linkInPos.y,
					});
				}
			}
		}
	}

	combinedGroupPairsMap.forEach((pairs, cgIndex) => {
		if (pairs.length >= 2) {
			const cgInfo = removedCombinedGroupInfos[cgIndex];
			combineLinksGroup(state, pairs, cgInfo.type, nodes, edges, result);

			const lastGroup =
				state.combinedLinkGroups[state.combinedLinkGroups.length - 1];
			if (lastGroup && cgInfo.combinedOutPos) {
				nodes.update({
					id: lastGroup.combinedOutId,
					x: cgInfo.combinedOutPos.x,
					y: cgInfo.combinedOutPos.y,
				});
			}
			if (lastGroup && cgInfo.combinedInPos) {
				nodes.update({
					id: lastGroup.combinedInId,
					x: cgInfo.combinedInPos.x,
					y: cgInfo.combinedInPos.y,
				});
			}
		} else if (pairs.length === 1) {
			const info = removedLinkInfos.find(
				(i) => i.combinedGroupIndex === cgIndex,
			);
			if (info && info.linkOutPos) {
				nodes.update({
					id: pairs[0].linkOutId,
					x: info.linkOutPos.x,
					y: info.linkOutPos.y,
				});
			}
			if (info && info.linkInPos) {
				nodes.update({
					id: pairs[0].linkInId,
					x: info.linkInPos.x,
					y: info.linkInPos.y,
				});
			}
		}
	});
}

export function findSplitEdgeForLink(
	splitNodeId: number,
	otherNodeId: number,
	isFromRecipe: boolean,
	itemClassName: string,
	group: ISplitGroup,
	edges: DataSet<IVisEdge>,
): any | null {
	const matchingSplitEdges = group.splitEdgeIds
		.map((eid) => edges.get(eid) as any)
		.filter((e: any) => e != null)
		.filter((e: any) => {
			if (isFromRecipe) {
				return e.from === splitNodeId && e.to === otherNodeId;
			} else {
				return e.from === otherNodeId && e.to === splitNodeId;
			}
		});

	if (matchingSplitEdges.length === 1) {
		return matchingSplitEdges[0];
	}
	if (matchingSplitEdges.length > 1) {
		const itemName = model.getItem(itemClassName).prototype.name;
		return (
			matchingSplitEdges.find((e: any) => {
				const label = ((e.label || '') as string).split('\n')[0].trim();
				return label === itemName;
			}) || matchingSplitEdges[0]
		);
	}
	return null;
}

export function buildSplitNodeTooltip(
	recipeNode: RecipeNode,
	splitAmount: number,
): HTMLElement {
	const splitRecipeData = new RecipeData(
		recipeNode.recipeData.machine,
		recipeNode.recipeData.recipe,
		splitAmount,
		recipeNode.recipeData.clockSpeed,
	);
	const splitMachineGroup = new MachineGroup(splitRecipeData);
	const splitMultiplier =
		splitAmount *
		recipeNode.recipeData.machine.metadata.manufacturingSpeed *
		(recipeNode.recipeData.clockSpeed / 100) *
		(60 / recipeNode.recipeData.recipe.time);

	const titleLines: string[] = [];
	for (const machine of splitMachineGroup.machines) {
		titleLines.push(
			machine.amount +
				'x ' +
				recipeNode.recipeData.machine.name +
				' at <b>' +
				machine.clockSpeed +
				'%</b> clock speed',
		);
	}
	titleLines.push('');
	titleLines.push(
		'Needed power: ' + Numbers.round(splitMachineGroup.power.average) + ' MW',
	);
	titleLines.push('');
	for (const ingredient of recipeNode.recipeData.recipe.ingredients) {
		const item = model.getItem(ingredient.item);
		titleLines.push(
			'<b>IN:</b> ' +
				Strings.formatItemAmount(
					ingredient.amount * splitMultiplier,
					ingredient.item,
				) +
				' - ' +
				item.prototype.name,
		);
	}
	for (const product of recipeNode.recipeData.recipe.products) {
		const item = model.getItem(product.item);
		titleLines.push(
			'<b>OUT:</b> ' +
				Strings.formatItemAmount(
					product.amount * splitMultiplier,
					product.item,
				) +
				' - ' +
				item.prototype.name,
		);
	}
	const titleEl = document.createElement('div');
	titleEl.innerHTML = titleLines.join('<br>');
	return titleEl;
}

export function buildScaledSplitEdge(
	edgeId: number,
	originalVisEdge: any,
	splitNodeId: number,
	fraction: number,
	result: ProductionResult,
	splitNodeIsFrom: boolean,
	resolvedGraphEdge?: any,
	baseAmountMultiplier?: number,
): any {
	const graphEdge =
		resolvedGraphEdge ||
		result.graph.edges.find((e) => e.id === originalVisEdge.id);
	let scaledLabel = originalVisEdge.label || '';
	if (graphEdge) {
		const baseAmount =
			graphEdge.itemAmount.amount * (baseAmountMultiplier ?? 1);
		const scaledAmount = baseAmount * fraction;
		scaledLabel =
			model.getItem(graphEdge.itemAmount.item).prototype.name +
			'\n' +
			Strings.formatItemAmount(scaledAmount, graphEdge.itemAmount.item);
	}
	return {
		id: edgeId,
		from: splitNodeIsFrom ? splitNodeId : originalVisEdge.from,
		to: splitNodeIsFrom ? originalVisEdge.to : splitNodeId,
		label: scaledLabel,
		color: originalVisEdge.color || {
			color: 'rgba(105, 125, 145, 1)',
			highlight: 'rgba(134, 151, 167, 1)',
		},
		font: originalVisEdge.font || {
			color: 'rgba(238, 238, 238, 1)',
		},
		smooth: originalVisEdge.smooth,
	};
}

export function resolveVisEdgeToGraphEdge(
	state: ICustomGraphState,
	visEdge: any,
	nodeId: number,
	result: ProductionResult,
): {
	graphEdge: any;
	splitGroup: ISplitGroup | null;
	splitNodeIndex: number;
} | null {
	const directMatch = result.graph.edges.find((e) => e.id === visEdge.id);
	if (directMatch) {
		return { graphEdge: directMatch, splitGroup: null, splitNodeIndex: -1 };
	}

	for (const sg of state.splitGroups) {
		if (sg.originalNodeId === nodeId) {
			continue;
		}
		if (sg.splitEdgeIds.indexOf(visEdge.id) === -1) {
			continue;
		}

		const visFrom = visEdge.from as number;
		const visTo = visEdge.to as number;

		let splitNodeId: number | null = null;
		let splitNodeIndex = -1;
		for (let si = 0; si < sg.splitNodeIds.length; si++) {
			if (sg.splitNodeIds[si] === visFrom || sg.splitNodeIds[si] === visTo) {
				splitNodeId = sg.splitNodeIds[si];
				splitNodeIndex = si;
				break;
			}
		}
		if (splitNodeId === null) {
			continue;
		}

		let graphFrom = visFrom === splitNodeId ? sg.originalNodeId : visFrom;
		let graphTo = visTo === splitNodeId ? sg.originalNodeId : visTo;

		for (const otherSg of state.splitGroups) {
			if (otherSg === sg) continue;
			if (otherSg.splitNodeIds.indexOf(graphFrom) !== -1) {
				graphFrom = otherSg.originalNodeId;
			}
			if (otherSg.splitNodeIds.indexOf(graphTo) !== -1) {
				graphTo = otherSg.originalNodeId;
			}
		}

		const itemName = ((visEdge.label || '') as string).split('\n')[0].trim();
		const graphEdge = result.graph.edges.find(
			(e) =>
				e.from.id === graphFrom &&
				e.to.id === graphTo &&
				model.getItem(e.itemAmount.item).prototype.name === itemName,
		);

		if (graphEdge) {
			return { graphEdge: graphEdge, splitGroup: sg, splitNodeIndex: splitNodeIndex };
		}
		break;
	}

	return null;
}

export function getSplitNodeFraction(
	sg: ISplitGroup,
	splitNodeIndex: number,
	result: ProductionResult,
): number {
	const splitItemClassName = sg.descriptor.splitItemClassName;
	if (!splitItemClassName) {
		return 1;
	}

	const isOutputSplit = sg.descriptor.splitType === 'output';
	const splitItemEdges = result.graph.edges.filter(
		(e) =>
			(isOutputSplit ? e.from.id : e.to.id) === sg.originalNodeId &&
			e.itemAmount.item === splitItemClassName,
	);

	const totalSplitAmount = splitItemEdges.reduce(
		(sum, e) => sum + e.itemAmount.amount,
		0,
	);
	if (totalSplitAmount <= 0 || splitNodeIndex >= splitItemEdges.length) {
		return 1;
	}

	return splitItemEdges[splitNodeIndex].itemAmount.amount / totalSplitAmount;
}

export function combineSplitGroup(
	state: ICustomGraphState,
	groupIndex: number,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
): void {
	let group = state.splitGroups[groupIndex];
	const recombiningRecipeKey = group.descriptor.recipeNodeKey;

	for (let i = state.splitGroups.length - 1; i >= 0; i--) {
		const sg = state.splitGroups[i];
		if (sg !== group && group.splitNodeIds.indexOf(sg.originalNodeId) !== -1) {
			combineSplitGroup(state, i, nodes, edges);
		}
	}
	groupIndex = state.splitGroups.findIndex((g) => g === group);
	if (groupIndex === -1) return;

	const dependentGroupInfos: {
		group: ISplitGroup;
		recipeKey: string;
		splitType: 'output' | 'input';
		splitItemClassName?: string;
		splitNodePositions?: { [index: string]: { x: number; y: number } };
	}[] = [];

	for (const otherGroup of state.splitGroups) {
		if (otherGroup === group) continue;
		const hasConnection = otherGroup.splitEdgeIds.some((eid) => {
			const edge = edges.get(eid) as any;
			if (!edge) return false;
			return (
				group.splitNodeIds.indexOf(edge.from as number) !== -1 ||
				group.splitNodeIds.indexOf(edge.to as number) !== -1
			);
		});
		if (hasConnection) {
			const depPos: { [index: string]: { x: number; y: number } } = {};
			if (state.network) {
				const pos = state.network.getPositions(otherGroup.splitNodeIds);
				for (let i = 0; i < otherGroup.splitNodeIds.length; i++) {
					if (pos[otherGroup.splitNodeIds[i]]) {
						depPos[i.toString()] = pos[otherGroup.splitNodeIds[i]];
					}
				}
			}
			dependentGroupInfos.push({
				group: otherGroup,
				recipeKey: otherGroup.descriptor.recipeNodeKey,
				splitType: otherGroup.descriptor.splitType,
				splitItemClassName: otherGroup.descriptor.splitItemClassName,
				splitNodePositions: depPos,
			});
		}
	}

	for (const depInfo of dependentGroupInfos) {
		const depIdx = state.splitGroups.indexOf(depInfo.group);
		if (depIdx !== -1) {
			combineSplitGroup(state, depIdx, nodes, edges);
		}
	}

	groupIndex = state.splitGroups.findIndex(
		(g) => g.descriptor.recipeNodeKey === recombiningRecipeKey,
	);
	if (groupIndex === -1) return;
	group = state.splitGroups[groupIndex];

	const restoredLinkDescriptors: {
		descriptor: ILinkNodeDescriptor;
		linkOutPos?: { x: number; y: number };
		linkInPos?: { x: number; y: number };
	}[] = [];

	for (let i = state.combinedLinkGroups.length - 1; i >= 0; i--) {
		const cg = state.combinedLinkGroups[i];
		const hasSplitPairs = cg.originalPairs.some(
			(p) =>
				p.descriptor.splitRecipeKey === group.descriptor.recipeNodeKey ||
				p.descriptor.otherSplitRecipeKey === group.descriptor.recipeNodeKey,
		);
		if (hasSplitPairs) {
			for (const pair of cg.originalPairs) {
				if (pair.descriptor.otherSplitRecipeKey === group.descriptor.recipeNodeKey) {
					restoredLinkDescriptors.push({
						descriptor: {
							fromNodeKey: pair.descriptor.fromNodeKey,
							toNodeKey: pair.descriptor.toNodeKey,
							itemClassName: pair.descriptor.itemClassName,
							splitRecipeKey: pair.descriptor.splitRecipeKey,
							splitNodeIndex: pair.descriptor.splitNodeIndex,
						},
						linkOutPos: pair.descriptor.linkOutPos,
						linkInPos: pair.descriptor.linkInPos,
					});
				}
			}
			for (const edgeId of cg.combinedEdgeIds) {
				edges.remove(edgeId);
			}
			nodes.remove(cg.combinedOutId);
			nodes.remove(cg.combinedInId);
			state.combinedLinkGroups.splice(i, 1);
		}
	}

	for (let i = state.linkPairs.length - 1; i >= 0; i--) {
		const pair = state.linkPairs[i];
		if (pair.descriptor.splitRecipeKey === group.descriptor.recipeNodeKey) {
			const linkPositions = state.network.getPositions([
				pair.linkOutId,
				pair.linkInId,
			]);
			restoredLinkDescriptors.push({
				descriptor: {
					fromNodeKey: pair.descriptor.fromNodeKey,
					toNodeKey: pair.descriptor.toNodeKey,
					itemClassName: pair.descriptor.itemClassName,
					...(pair.descriptor.otherSplitRecipeKey != null
						? {
								splitRecipeKey: pair.descriptor.otherSplitRecipeKey,
								splitNodeIndex: pair.descriptor.otherSplitNodeIndex,
						  }
						: {}),
				},
				linkOutPos: linkPositions[pair.linkOutId],
				linkInPos: linkPositions[pair.linkInId],
			});
			edges.remove(pair.outEdgeId);
			edges.remove(pair.inEdgeId);
			nodes.remove(pair.linkOutId);
			nodes.remove(pair.linkInId);
			edges.add(pair.originalEdgeData);
			state.linkPairs.splice(i, 1);
		} else if (pair.descriptor.otherSplitRecipeKey === group.descriptor.recipeNodeKey) {
			const linkPositions = state.network.getPositions([
				pair.linkOutId,
				pair.linkInId,
			]);
			restoredLinkDescriptors.push({
				descriptor: {
					fromNodeKey: pair.descriptor.fromNodeKey,
					toNodeKey: pair.descriptor.toNodeKey,
					itemClassName: pair.descriptor.itemClassName,
					splitRecipeKey: pair.descriptor.splitRecipeKey,
					splitNodeIndex: pair.descriptor.splitNodeIndex,
				},
				linkOutPos: linkPositions[pair.linkOutId],
				linkInPos: linkPositions[pair.linkInId],
			});
			edges.remove(pair.outEdgeId);
			edges.remove(pair.inEdgeId);
			nodes.remove(pair.linkOutId);
			nodes.remove(pair.linkInId);
			state.linkPairs.splice(i, 1);
		}
	}

	let avgX = 0;
	let avgY = 0;
	let posCount = 0;
	if (state.network && group.splitNodeIds.length > 0) {
		const splitPositions = state.network.getPositions(group.splitNodeIds);
		for (const splitNodeId of group.splitNodeIds) {
			if (splitPositions[splitNodeId]) {
				avgX += splitPositions[splitNodeId].x;
				avgY += splitPositions[splitNodeId].y;
				posCount++;
			}
		}
	}

	for (const edgeId of group.splitEdgeIds) {
		edges.remove(edgeId);
	}

	for (const nodeId of group.splitNodeIds) {
		nodes.remove(nodeId);
	}

	nodes.add(group.originalNodeData);
	if (posCount > 0) {
		nodes.update({
			id: group.originalNodeData.id,
			x: avgX / posCount,
			y: avgY / posCount,
		});
	}

	for (const edgeData of group.originalEdgesData) {
		edges.add(edgeData);
	}

	state.splitGroups.splice(groupIndex, 1);

	if (restoredLinkDescriptors.length > 0 && state.currentResult) {
		const seen = new Set<string>();
		for (const info of restoredLinkDescriptors) {
			let key =
				info.descriptor.fromNodeKey +
				'||' +
				info.descriptor.toNodeKey +
				'||' +
				info.descriptor.itemClassName;
			if (info.descriptor.splitRecipeKey) {
				key +=
					'||' +
					info.descriptor.splitRecipeKey +
					'||' +
					info.descriptor.splitNodeIndex;
			}
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);

			const graphEdge = state.currentResult.graph.edges.find(
				(e) =>
					getNodeKey(e.from) === info.descriptor.fromNodeKey &&
					getNodeKey(e.to) === info.descriptor.toNodeKey &&
					e.itemAmount.item === info.descriptor.itemClassName,
			);
			if (!graphEdge) {
				continue;
			}

			if (
				info.descriptor.splitRecipeKey != null &&
				info.descriptor.splitNodeIndex != null
			) {
				info.descriptor.linkOutPos = info.linkOutPos;
				info.descriptor.linkInPos = info.linkInPos;
				applyStoredSplitEdgeLink(
					state,
					info.descriptor,
					graphEdge,
					nodes,
					edges,
					state.currentResult!,
				);
				continue;
			}

			const visEdge = edges.get(graphEdge.id);
			if (!visEdge) {
				continue;
			}

			const positions = state.network.getPositions([
				graphEdge.from.id,
				graphEdge.to.id,
			]);
			const fromPos = positions[graphEdge.from.id];
			const toPos = positions[graphEdge.to.id];
			if (!fromPos || !toPos) {
				continue;
			}

			const pair = createLinkPair(
				state,
				nodes,
				edges,
				graphEdge.from.id,
				graphEdge.to.id,
				visEdge,
				info.descriptor,
				graphEdge.itemAmount.item,
				graphEdge.itemAmount.amount,
				fromPos,
				toPos,
				getNodeDisplayName(graphEdge.from),
				getNodeDisplayName(graphEdge.to),
			);

			if (info.linkOutPos) {
				nodes.update({
					id: pair.linkOutId,
					x: info.linkOutPos.x,
					y: info.linkOutPos.y,
				});
			}
			if (info.linkInPos) {
				nodes.update({
					id: pair.linkInId,
					x: info.linkInPos.x,
					y: info.linkInPos.y,
				});
			}
		}
	}

	if (dependentGroupInfos.length > 0 && state.currentResult) {
		for (const depInfo of dependentGroupInfos) {
			const graphNode = state.currentResult.graph.nodes.find(
				(n) => getNodeKey(n) === depInfo.recipeKey,
			);
			if (!graphNode || !(graphNode instanceof RecipeNode)) continue;
			if (!nodes.get(graphNode.id)) continue;
			const targetItem = depInfo.splitItemClassName;
			if (!targetItem) continue;
			const dirEdges = state.currentResult.graph.edges.filter((e) =>
				depInfo.splitType === 'output'
					? e.from.id === graphNode.id && e.itemAmount.item === targetItem
					: e.to.id === graphNode.id && e.itemAmount.item === targetItem,
			);
			if (dirEdges.length < 2) continue;
			splitRecipeByDirection(
				state,
				graphNode.id,
				graphNode,
				nodes,
				edges,
				state.currentResult,
				depInfo.splitType,
				targetItem,
			);
		}
	}

	state.saveGraphState();
}

export function getVisEdgesForNode(nodeId: number, edges: DataSet<IVisEdge>): any[] {
	return edges.get().filter((e: any) => e.from === nodeId || e.to === nodeId);
}

export function applyStoredSplits(
	state: ICustomGraphState,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
	descriptors: ISplitDescriptor[],
): void {
	if (descriptors.length === 0) {
		return;
	}

	for (const descriptor of descriptors) {
		if (descriptor.parentSplitRecipeKey != null && descriptor.parentSplitNodeIndex != null) {
			// Sub-split: the parent recipe node is already split.
			// splitSplitNodeByDirection is not yet implemented — skip.
			continue;
		}

		const graphNode = result.graph.nodes.find(
			(n) => getNodeKey(n) === descriptor.recipeNodeKey,
		);
		if (!graphNode || !(graphNode instanceof RecipeNode)) {
			continue;
		}

		const visNode = nodes.get(graphNode.id);
		if (!visNode) {
			continue;
		}

		if (descriptor.splitType === 'output') {
			const splitItem = descriptor.splitItemClassName;
			const outputEdges = result.graph.edges.filter(
				(e) => e.from.id === graphNode.id,
			);
			let targetItem = splitItem;
			if (!targetItem) {
				const itemEdgeCount: { [item: string]: number } = {};
				for (const e of outputEdges) {
					itemEdgeCount[e.itemAmount.item] =
						(itemEdgeCount[e.itemAmount.item] || 0) + 1;
				}
				const candidates = Object.keys(itemEdgeCount).filter(
					(item) => itemEdgeCount[item] >= 2,
				);
				if (candidates.length === 0) {
					continue;
				}
				targetItem = candidates[0];
			}
			const matchingEdges = outputEdges.filter(
				(e) => e.itemAmount.item === targetItem,
			);
			if (matchingEdges.length <= 1) {
				continue;
			}
			splitRecipeByOutput(
				state,
				graphNode.id,
				graphNode,
				nodes,
				edges,
				result,
				targetItem,
			);
		} else {
			const splitItem = descriptor.splitItemClassName;
			const inputEdges = result.graph.edges.filter(
				(e) => e.to.id === graphNode.id,
			);
			let targetItem = splitItem;
			if (!targetItem) {
				const itemEdgeCount: { [item: string]: number } = {};
				for (const e of inputEdges) {
					itemEdgeCount[e.itemAmount.item] =
						(itemEdgeCount[e.itemAmount.item] || 0) + 1;
				}
				const candidates = Object.keys(itemEdgeCount).filter(
					(item) => itemEdgeCount[item] >= 2,
				);
				if (candidates.length === 0) {
					continue;
				}
				targetItem = candidates[0];
			}
			const matchingEdges = inputEdges.filter(
				(e) => e.itemAmount.item === targetItem,
			);
			if (matchingEdges.length <= 1) {
				continue;
			}
			splitRecipeByInput(
				state,
				graphNode.id,
				graphNode,
				nodes,
				edges,
				result,
				targetItem,
			);
		}

		const group = state.splitGroups[state.splitGroups.length - 1];
		if (group && descriptor.splitNodePositions) {
			for (let i = 0; i < group.splitNodeIds.length; i++) {
				const posKey = i.toString();
				if (descriptor.splitNodePositions[posKey]) {
					nodes.update({
						id: group.splitNodeIds[i],
						x: descriptor.splitNodePositions[posKey].x,
						y: descriptor.splitNodePositions[posKey].y,
					});
				}
			}
		}
	}
}
