import { DataSet } from 'vis-network';
import { IVisNode } from '@src/Tools/Production/Result/IVisNode';
import { IVisEdge } from '@src/Tools/Production/Result/IVisEdge';
import { ILinkNodeDescriptor } from '@src/Tools/Production/IProductionData';
import { ProductionResult } from '@src/Tools/Production/Result/ProductionResult';
import model from '@src/Data/Model';
import { Strings } from '@src/Utils/Strings';
import { ICustomGraphState, ILinkPair, ICombinedLinkGroup } from './types';
import { getNodeKey, getNodeDisplayName } from './nodeUtils';
import { createLinkPair, getOtherSideLinkColor, applyStoredSplitEdgeLink } from './linkOperations';

/**
 * Count the effective number of edges per item for split eligibility,
 * treating edges that belong to the same combined link group as a single edge.
 */
export function countEffectiveEdgesPerItem(
	state: ICustomGraphState,
	graphEdges: any[],
	nodeId?: number,
): { [item: string]: number } {
	const effectiveCount: { [item: string]: number } = {};
	const countedCombinedGroups = new Set<ICombinedLinkGroup>();

	for (const e of graphEdges) {
		const edgeFromKey = getNodeKey(e.from);
		const edgeToKey = getNodeKey(e.to);
		const edgeItem = e.itemAmount.item;

		const combinedGroup = state.combinedLinkGroups.find((g) =>
			g.originalPairs.some(
				(p) =>
					p.descriptor.fromNodeKey === edgeFromKey &&
					p.descriptor.toNodeKey === edgeToKey &&
					p.descriptor.itemClassName === edgeItem,
			),
		);

		if (combinedGroup) {
			if (!countedCombinedGroups.has(combinedGroup)) {
				countedCombinedGroups.add(combinedGroup);
				effectiveCount[edgeItem] = (effectiveCount[edgeItem] || 0) + 1;
			}
		} else {
			let edgeCount = 1;
			if (nodeId != null) {
				const isFromNode = e.from.id === nodeId;
				edgeCount = countVisEdgesForSplitEligibility(state, e, isFromNode);
			}
			effectiveCount[edgeItem] = (effectiveCount[edgeItem] || 0) + edgeCount;
		}
	}

	return effectiveCount;
}

/**
 * Count how many vis edges a single graph edge effectively represents,
 * accounting for the OTHER endpoint being in a split group.
 */
export function countVisEdgesForSplitEligibility(
	state: ICustomGraphState,
	graphEdge: any,
	isFromNode: boolean,
): number {
	const otherNodeId = isFromNode ? graphEdge.to.id : graphEdge.from.id;
	const otherSplitGroup = state.splitGroups.find(
		(g) => g.originalNodeId === otherNodeId,
	);
	if (!otherSplitGroup) {
		return 1;
	}

	const edgeDirForOther = isFromNode ? 'input' : 'output';
	const isPrimary =
		otherSplitGroup.descriptor.splitType === edgeDirForOther &&
		graphEdge.itemAmount.item === otherSplitGroup.descriptor.splitItemClassName;

	return isPrimary ? 1 : otherSplitGroup.splitNodeIds.length;
}

/**
 * Get combined link groups whose nodes are among the selected node IDs.
 */
export function getSelectedCombinedGroups(
	state: ICustomGraphState,
	selectedNodeIds: number[],
): ICombinedLinkGroup[] {
	const groups = new Set<ICombinedLinkGroup>();
	for (const nodeId of selectedNodeIds) {
		const group = state.combinedLinkGroups.find(
			(g) => g.combinedOutId === nodeId || g.combinedInId === nodeId,
		);
		if (group) {
			groups.add(group);
		}
	}
	return Array.from(groups);
}

/**
 * Check whether the current selection can be combined into a combined group.
 */
export function canCombineSelection(
	state: ICustomGraphState,
	selectedNodeIds: number[],
): boolean {
	for (const nodeId of selectedNodeIds) {
		const isLinkNode = state.linkPairs.some(
			(p) => p.linkOutId === nodeId || p.linkInId === nodeId,
		);
		const isCombinedLinkNode = state.combinedLinkGroups.some(
			(g) => g.combinedOutId === nodeId || g.combinedInId === nodeId,
		);
		if (!isLinkNode && !isCombinedLinkNode) {
			return false;
		}
	}

	const regularPairs = getSelectedLinkPairs(state, selectedNodeIds);
	const combinedGroups = getSelectedCombinedGroups(state, selectedNodeIds);

	const sourceCount = regularPairs.length + combinedGroups.length;
	if (sourceCount < 2) {
		return false;
	}

	const allDescriptors: ILinkNodeDescriptor[] = [];
	for (const pair of regularPairs) {
		allDescriptors.push(pair.descriptor);
	}
	for (const group of combinedGroups) {
		for (const origPair of group.originalPairs) {
			allDescriptors.push(origPair.descriptor);
		}
	}

	if (allDescriptors.length < 2) {
		return false;
	}

	const toCounts: { [key: string]: number } = {};
	const fromCounts: { [key: string]: number } = {};
	for (const desc of allDescriptors) {
		const toKey = desc.itemClassName + '||to||' + desc.toNodeKey;
		toCounts[toKey] = (toCounts[toKey] || 0) + 1;
		const fromKey = desc.itemClassName + '||from||' + desc.fromNodeKey;
		fromCounts[fromKey] = (fromCounts[fromKey] || 0) + 1;
	}
	for (const key in toCounts) {
		if (toCounts.hasOwnProperty(key) && toCounts[key] >= 2) {
			return true;
		}
	}
	for (const key in fromCounts) {
		if (fromCounts.hasOwnProperty(key) && fromCounts[key] >= 2) {
			return true;
		}
	}
	return false;
}

/**
 * Get unique link pairs corresponding to the selected node IDs.
 */
export function getSelectedLinkPairs(
	state: ICustomGraphState,
	selectedNodeIds: number[],
): ILinkPair[] {
	const pairSet = new Set<ILinkPair>();
	for (const nodeId of selectedNodeIds) {
		const pair = state.linkPairs.find(
			(p) => p.linkOutId === nodeId || p.linkInId === nodeId,
		);
		if (pair) {
			pairSet.add(pair);
		}
	}
	return Array.from(pairSet);
}

export function handleCombineLinks(
	state: ICustomGraphState,
	selectedNodeIds: number[],
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
): void {
	const selectedPairs = getSelectedLinkPairs(state, selectedNodeIds);
	const selectedCombinedGroups = getSelectedCombinedGroups(state, selectedNodeIds);

	if (selectedCombinedGroups.length === 0) {
		if (selectedPairs.length >= 2) {
			tryCombinePairs(state, selectedPairs, nodes, edges, result);
		}
		return;
	}

	const allDescriptors: ILinkNodeDescriptor[] = [];
	for (const pair of selectedPairs) {
		allDescriptors.push({ ...pair.descriptor });
	}
	for (const group of selectedCombinedGroups) {
		for (const origPair of group.originalPairs) {
			allDescriptors.push({ ...origPair.descriptor });
		}
	}

	const groupIndices = selectedCombinedGroups
		.map((g) => state.combinedLinkGroups.indexOf(g))
		.filter((i) => i !== -1)
		.sort((a, b) => b - a);

	for (const idx of groupIndices) {
		uncombineCombinedGroup(state, idx, nodes, edges, result);
	}

	const allPairs: ILinkPair[] = [];
	for (const desc of allDescriptors) {
		const pair = state.linkPairs.find(
			(p) =>
				p.descriptor.fromNodeKey === desc.fromNodeKey &&
				p.descriptor.toNodeKey === desc.toNodeKey &&
				p.descriptor.itemClassName === desc.itemClassName,
		);
		if (pair && allPairs.indexOf(pair) === -1) {
			allPairs.push(pair);
		}
	}

	if (allPairs.length >= 2) {
		tryCombinePairs(state, allPairs, nodes, edges, result);
	}
}

export function tryCombinePairs(
	state: ICustomGraphState,
	pairs: ILinkPair[],
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
): void {
	const toGroups: { [key: string]: ILinkPair[] } = {};
	const fromGroups: { [key: string]: ILinkPair[] } = {};

	for (const pair of pairs) {
		const toKey = pair.descriptor.itemClassName + '||' + pair.descriptor.toNodeKey;
		if (!toGroups[toKey]) {
			toGroups[toKey] = [];
		}
		toGroups[toKey].push(pair);

		const fromKey = pair.descriptor.itemClassName + '||' + pair.descriptor.fromNodeKey;
		if (!fromGroups[fromKey]) {
			fromGroups[fromKey] = [];
		}
		fromGroups[fromKey].push(pair);
	}

	const combined = new Set<ILinkPair>();

	for (const key in toGroups) {
		if (toGroups.hasOwnProperty(key) && toGroups[key].length >= 2) {
			const groupPairs = toGroups[key].filter((p) => !combined.has(p));
			if (groupPairs.length >= 2) {
				combineLinksGroup(state, groupPairs, 'out', nodes, edges, result);
				for (const p of groupPairs) {
					combined.add(p);
				}
			}
		}
	}

	for (const key in fromGroups) {
		if (fromGroups.hasOwnProperty(key) && fromGroups[key].length >= 2) {
			const groupPairs = fromGroups[key].filter((p) => !combined.has(p));
			if (groupPairs.length >= 2) {
				combineLinksGroup(state, groupPairs, 'in', nodes, edges, result);
				for (const p of groupPairs) {
					combined.add(p);
				}
			}
		}
	}
}

export function combineLinksGroup(
	state: ICustomGraphState,
	pairs: ILinkPair[],
	type: 'out' | 'in',
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
): void {
	const itemClassName = pairs[0].descriptor.itemClassName;
	const itemName = model.getItem(itemClassName).prototype.name;
	const sourceKey =
		type === 'out'
			? pairs[0].descriptor.toNodeKey
			: pairs[0].descriptor.fromNodeKey;

	const pairEdgeData: {
		fromVisId: number;
		toVisId: number;
		outLabel: string;
		inLabel: string;
		amount: number;
	}[] = [];
	let totalAmount = 0;

	for (const pair of pairs) {
		const outEdge = edges.get(pair.outEdgeId) as any;
		const inEdge = edges.get(pair.inEdgeId) as any;
		if (!outEdge || !inEdge) {
			continue;
		}

		const fromVisId = outEdge.from;
		const toVisId = inEdge.to;

		let amount = 0;
		if (pair.amount != null) {
			amount = pair.amount;
		} else {
			const graphEdge = result.graph.edges.find((e) => {
				return (
					getNodeKey(e.from) === pair.descriptor.fromNodeKey &&
					getNodeKey(e.to) === pair.descriptor.toNodeKey &&
					e.itemAmount.item === pair.descriptor.itemClassName
				);
			});
			if (graphEdge) {
				amount = graphEdge.itemAmount.amount;
			}
		}
		totalAmount += amount;

		pairEdgeData.push({
			fromVisId: fromVisId,
			toVisId: toVisId,
			outLabel: outEdge.label || '',
			inLabel: inEdge.label || '',
			amount: amount,
		});
	}

	if (pairEdgeData.length < 2) {
		return;
	}

	const firstPair = pairs[0];
	const posData = state.network.getPositions([
		firstPair.linkOutId,
		firstPair.linkInId,
	]);
	const combinedOutPos = posData[firstPair.linkOutId] || { x: 0, y: 0 };
	const combinedInPos = posData[firstPair.linkInId] || { x: 0, y: 0 };

	const removedPairs: ILinkPair[] = [];
	for (const pair of pairs) {
		edges.remove(pair.outEdgeId);
		edges.remove(pair.inEdgeId);
		nodes.remove(pair.linkOutId);
		nodes.remove(pair.linkInId);

		const idx = state.linkPairs.indexOf(pair);
		if (idx !== -1) {
			state.linkPairs.splice(idx, 1);
		}
		removedPairs.push(pair);
	}

	const sourceAmounts = new Map<number, number>();
	for (const data of pairEdgeData) {
		sourceAmounts.set(
			data.fromVisId,
			(sourceAmounts.get(data.fromVisId) || 0) + data.amount,
		);
	}
	const targetAmounts = new Map<number, number>();
	for (const data of pairEdgeData) {
		targetAmounts.set(
			data.toVisId,
			(targetAmounts.get(data.toVisId) || 0) + data.amount,
		);
	}
	const uniqueSources = sourceAmounts.size;
	const uniqueTargets = targetAmounts.size;

	const amountStr = Strings.formatItemAmount(totalAmount, itemClassName);

	const sourceGraphNode = result.graph.nodes.find(
		(n) => getNodeKey(n) === sourceKey,
	);
	const sourceName = sourceGraphNode
		? getNodeDisplayName(sourceGraphNode)
		: sourceKey;

	let outLabel: string;
	let inLabel: string;

	if (type === 'out') {
		const toStr =
			uniqueTargets === 1
				? sourceName
				: sourceName + ' (' + uniqueTargets + ' splits)';
		outLabel =
			'<b>Link Out: ' +
			itemName +
			'</b>\n<i>To: ' +
			toStr +
			'</i>\n' +
			amountStr;
		inLabel =
			'<b>Link In: ' +
			itemName +
			'</b>\n<i>From: (' +
			uniqueSources +
			' sources)</i>\n' +
			amountStr;
	} else {
		const fromStr =
			uniqueSources === 1
				? sourceName
				: sourceName + ' (' + uniqueSources + ' splits)';
		outLabel =
			'<b>Link Out: ' +
			itemName +
			'</b>\n<i>To: (' +
			uniqueTargets +
			' destinations)</i>\n' +
			amountStr;
		inLabel =
			'<b>Link In: ' +
			itemName +
			'</b>\n<i>From: ' +
			fromStr +
			'</i>\n' +
			amountStr;
	}

	const combinedOutId = state.nextCombinedNodeId();
	const combinedInId = state.nextCombinedNodeId();
	const combinedEdgeIds: number[] = [];

	const defaultCombinedColor = {
		border: 'rgba(0, 0, 0, 0)',
		background: 'rgba(50, 160, 160, 1)',
		highlight: {
			border: 'rgba(238, 238, 238, 1)',
			background: 'rgba(80, 190, 190, 1)',
		},
	};
	const firstToKey = pairs[0].descriptor.toNodeKey;
	const firstFromKey = pairs[0].descriptor.fromNodeKey;
	const firstToVisId = pairEdgeData[0].toVisId;
	const firstFromVisId = pairEdgeData[0].fromVisId;
	const combinedOutColor = getOtherSideLinkColor(firstToKey, firstToVisId, nodes, defaultCombinedColor);
	const combinedInColor = getOtherSideLinkColor(firstFromKey, firstFromVisId, nodes, defaultCombinedColor);

	nodes.add({
		id: combinedOutId,
		label: outLabel,
		x: combinedOutPos.x,
		y: combinedOutPos.y,
		color: combinedOutColor,
		font: {
			color: 'rgba(238, 238, 238, 1)',
		},
	});

	nodes.add({
		id: combinedInId,
		label: inLabel,
		x: combinedInPos.x,
		y: combinedInPos.y,
		color: combinedInColor,
		font: {
			color: 'rgba(238, 238, 238, 1)',
		},
	});

	const linkEdgeColor = {
		color: 'rgba(50, 160, 160, 0.8)',
		highlight: 'rgba(80, 190, 190, 1)',
	};
	const linkEdgeFont = {
		color: 'rgba(238, 238, 238, 1)',
	};

	sourceAmounts.forEach((srcAmount, srcId) => {
		const edgeId = state.nextCombinedEdgeId();
		combinedEdgeIds.push(edgeId);
		edges.add({
			id: edgeId,
			from: srcId,
			to: combinedOutId,
			label: itemName + '\n' + Strings.formatItemAmount(srcAmount, itemClassName),
			color: linkEdgeColor,
			font: linkEdgeFont,
		} as any);
	});
	targetAmounts.forEach((tgtAmount, tgtId) => {
		const edgeId = state.nextCombinedEdgeId();
		combinedEdgeIds.push(edgeId);
		edges.add({
			id: edgeId,
			from: combinedInId,
			to: tgtId,
			label: itemName + '\n' + Strings.formatItemAmount(tgtAmount, itemClassName),
			color: linkEdgeColor,
			font: linkEdgeFont,
		} as any);
	});

	const descriptor = {
		type: type,
		itemClassName: itemClassName,
		sourceKey: sourceKey,
		originalDescriptors: removedPairs.map((p) => ({ ...p.descriptor })),
	};

	const group: ICombinedLinkGroup = {
		type: type,
		itemClassName: itemClassName,
		sourceKey: sourceKey,
		originalPairs: removedPairs,
		combinedOutId: combinedOutId,
		combinedInId: combinedInId,
		combinedEdgeIds: combinedEdgeIds,
		descriptor: descriptor,
	};

	state.combinedLinkGroups.push(group);
	state.network.unselectAll();
	state.saveGraphState();
}

export function uncombineCombinedGroup(
	state: ICustomGraphState,
	groupIndex: number,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
): void {
	const group = state.combinedLinkGroups[groupIndex];

	const combinedPositions = state.network.getPositions([
		group.combinedOutId,
		group.combinedInId,
	]);
	const combinedOutPos = combinedPositions[group.combinedOutId] || { x: 0, y: 0 };
	const combinedInPos = combinedPositions[group.combinedInId] || { x: 0, y: 0 };

	for (const edgeId of group.combinedEdgeIds) {
		edges.remove(edgeId);
	}

	nodes.remove(group.combinedOutId);
	nodes.remove(group.combinedInId);

	const pairsNeedingOutPos: ILinkPair[] = [];
	const pairsNeedingInPos: ILinkPair[] = [];

	for (const originalPair of group.originalPairs) {
		const desc = originalPair.descriptor;

		const graphEdge = result.graph.edges.find((e) => {
			return (
				getNodeKey(e.from) === desc.fromNodeKey &&
				getNodeKey(e.to) === desc.toNodeKey &&
				e.itemAmount.item === desc.itemClassName
			);
		});

		if (!graphEdge) {
			if (originalPair.originalEdgeData) {
				edges.add(originalPair.originalEdgeData);
			}
			continue;
		}

		if (desc.splitRecipeKey != null && desc.splitNodeIndex != null) {
			if (originalPair.originalEdgeData) {
				edges.add(originalPair.originalEdgeData);
			}
			const pairCountBefore = state.linkPairs.length;
			const applied = applyStoredSplitEdgeLink(
				state,
				desc,
				graphEdge,
				nodes,
				edges,
				result,
				originalPair.amount,
			);
			if (applied && state.linkPairs.length > pairCountBefore) {
				const splitNewPair = state.linkPairs[state.linkPairs.length - 1];
				if (!desc.linkOutPos) {
					pairsNeedingOutPos.push(splitNewPair);
				}
				if (!desc.linkInPos) {
					pairsNeedingInPos.push(splitNewPair);
				}
			}
			continue;
		}

		const positions = state.network.getPositions([
			graphEdge.from.id,
			graphEdge.to.id,
		]);
		const fromPos = positions[graphEdge.from.id] || { x: 0, y: 0 };
		const toPos = positions[graphEdge.to.id] || { x: 0, y: 0 };

		edges.add(originalPair.originalEdgeData);

		const newPair = createLinkPair(
			state,
			nodes,
			edges,
			graphEdge.from.id,
			graphEdge.to.id,
			originalPair.originalEdgeData,
			desc,
			graphEdge.itemAmount.item,
			graphEdge.itemAmount.amount,
			fromPos,
			toPos,
			getNodeDisplayName(graphEdge.from),
			getNodeDisplayName(graphEdge.to),
		);

		if (desc.linkOutPos) {
			nodes.update({
				id: newPair.linkOutId,
				x: desc.linkOutPos.x,
				y: desc.linkOutPos.y,
			});
		} else {
			pairsNeedingOutPos.push(newPair);
		}
		if (desc.linkInPos) {
			nodes.update({
				id: newPair.linkInId,
				x: desc.linkInPos.x,
				y: desc.linkInPos.y,
			});
		} else {
			pairsNeedingInPos.push(newPair);
		}
	}

	if (pairsNeedingOutPos.length > 0) {
		const count = pairsNeedingOutPos.length;
		const radius = count === 1 ? 0 : 80;
		for (let i = 0; i < count; i++) {
			const angle = (2 * Math.PI * i) / count - Math.PI / 2;
			nodes.update({
				id: pairsNeedingOutPos[i].linkOutId,
				x: combinedOutPos.x + radius * Math.cos(angle),
				y: combinedOutPos.y + radius * Math.sin(angle),
			});
		}
	}
	if (pairsNeedingInPos.length > 0) {
		const count = pairsNeedingInPos.length;
		const radius = count === 1 ? 0 : 80;
		for (let i = 0; i < count; i++) {
			const angle = (2 * Math.PI * i) / count - Math.PI / 2;
			nodes.update({
				id: pairsNeedingInPos[i].linkInId,
				x: combinedInPos.x + radius * Math.cos(angle),
				y: combinedInPos.y + radius * Math.sin(angle),
			});
		}
	}

	state.combinedLinkGroups.splice(groupIndex, 1);

	state.saveGraphState();
}

export function applyStoredCombinedLinks(
	state: ICustomGraphState,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
	descriptors: { type: 'out' | 'in'; itemClassName: string; sourceKey: string; originalDescriptors: any[]; combinedOutPos?: { x: number; y: number }; combinedInPos?: { x: number; y: number } }[],
): void {
	if (descriptors.length === 0) {
		return;
	}

	for (const descriptor of descriptors) {
		const matchingPairs: ILinkPair[] = [];

		for (const origDesc of descriptor.originalDescriptors) {
			const pair = state.linkPairs.find(
				(p) =>
					p.descriptor.fromNodeKey === origDesc.fromNodeKey &&
					p.descriptor.toNodeKey === origDesc.toNodeKey &&
					p.descriptor.itemClassName === origDesc.itemClassName &&
					p.descriptor.splitRecipeKey === origDesc.splitRecipeKey &&
					p.descriptor.splitNodeIndex === origDesc.splitNodeIndex,
			);
			if (pair) {
				matchingPairs.push(pair);
			}
		}

		if (matchingPairs.length < 2) {
			continue;
		}

		combineLinksGroup(
			state,
			matchingPairs,
			descriptor.type,
			nodes,
			edges,
			result,
		);

		const group = state.combinedLinkGroups[state.combinedLinkGroups.length - 1];
		if (group) {
			if (descriptor.combinedOutPos) {
				nodes.update({
					id: group.combinedOutId,
					x: descriptor.combinedOutPos.x,
					y: descriptor.combinedOutPos.y,
				});
			}
			if (descriptor.combinedInPos) {
				nodes.update({
					id: group.combinedInId,
					x: descriptor.combinedInPos.x,
					y: descriptor.combinedInPos.y,
				});
			}
		}
	}
}
