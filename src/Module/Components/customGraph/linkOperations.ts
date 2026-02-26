import { DataSet } from 'vis-network';
import { IVisNode } from '@src/Tools/Production/Result/IVisNode';
import { IVisEdge } from '@src/Tools/Production/Result/IVisEdge';
import { ILinkNodeDescriptor } from '@src/Tools/Production/IProductionData';
import { ProductionResult } from '@src/Tools/Production/Result/ProductionResult';
import { IntermediateNode } from '@src/Tools/Production/Result/Nodes/IntermediateNode';
import { InputNode } from '@src/Tools/Production/Result/Nodes/InputNode';
import { MinerNode } from '@src/Tools/Production/Result/Nodes/MinerNode';
import model from '@src/Data/Model';
import { Strings } from '@src/Utils/Strings';
import { ICustomGraphState, ILinkPair, ISplitGroup } from './types';
import { getNodeKey, getNodeDisplayName } from './nodeUtils';

export function getOtherSideLinkColor(
	otherNodeKey: string,
	otherVisId: number,
	nodes: DataSet<IVisNode>,
	defaultColor: any,
): any {
	if (otherNodeKey.startsWith('recipe:')) {
		return defaultColor;
	}
	const nodeData = nodes.get(otherVisId) as any;
	if (nodeData && nodeData.color) {
		return nodeData.color;
	}
	return defaultColor;
}

export function createLinkPair(
	state: ICustomGraphState,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	fromVisId: number,
	toVisId: number,
	originalEdgeData: any,
	descriptor: ILinkNodeDescriptor,
	itemClassName: string,
	itemAmount: number,
	fromPos: { x: number; y: number },
	toPos: { x: number; y: number },
	fromDisplayName: string,
	toDisplayName: string,
): ILinkPair {
	const midX = (fromPos.x + toPos.x) / 2;
	const midY = (fromPos.y + toPos.y) / 2;

	const itemName = model.getItem(itemClassName).prototype.name;
	const amountStr = Strings.formatItemAmount(itemAmount, itemClassName);
	const fromName = fromDisplayName;
	const toName = toDisplayName;

	const linkOutId = state.nextLinkNodeId();
	const linkInId = state.nextLinkNodeId();
	const outEdgeId = state.nextLinkEdgeId();
	const inEdgeId = state.nextLinkEdgeId();

	const outLabel =
		'<b>Link Out: ' +
		itemName +
		'</b>\n<i>To: ' +
		toName +
		'</i>\n' +
		amountStr;

	const inLabel =
		'<b>Link In: ' +
		itemName +
		'</b>\n<i>From: ' +
		fromName +
		'</i>\n' +
		amountStr;

	const defaultLinkNodeColor = {
		border: 'rgba(0, 0, 0, 0)',
		background: 'rgba(50, 160, 160, 1)',
		highlight: {
			border: 'rgba(238, 238, 238, 1)',
			background: 'rgba(80, 190, 190, 1)',
		},
	};
	const linkNodeFont = { color: 'rgba(238, 238, 238, 1)' };

	const linkOutColor = getOtherSideLinkColor(descriptor.toNodeKey, toVisId, nodes, defaultLinkNodeColor);
	const linkInColor = getOtherSideLinkColor(descriptor.fromNodeKey, fromVisId, nodes, defaultLinkNodeColor);

	nodes.add({ id: linkOutId, label: outLabel, x: midX, y: midY, color: linkOutColor, font: linkNodeFont });
	nodes.add({ id: linkInId, label: inLabel, x: midX, y: midY, color: linkInColor, font: linkNodeFont });

	state.network.redraw();

	let outHalfWidth = 100;
	let inHalfWidth = 100;
	try {
		const outBox = state.network.getBoundingBox(linkOutId);
		if (outBox) { outHalfWidth = (outBox.right - outBox.left) / 2; }
		const inBox = state.network.getBoundingBox(linkInId);
		if (inBox) { inHalfWidth = (inBox.right - inBox.left) / 2; }
	} catch (e) {
		// getBoundingBox may fail if node hasn't rendered yet; use defaults
	}

	nodes.update({ id: linkOutId, x: midX - outHalfWidth, y: midY });
	nodes.update({ id: linkInId, x: midX + inHalfWidth, y: midY });

	edges.remove(originalEdgeData.id);

	const edgeLabel = originalEdgeData.label || '';
	const linkEdgeColor = { color: 'rgba(50, 160, 160, 0.8)', highlight: 'rgba(80, 190, 190, 1)' };
	const linkEdgeFont = { color: 'rgba(238, 238, 238, 1)' };

	edges.add({ id: outEdgeId, from: fromVisId, to: linkOutId, label: edgeLabel, color: linkEdgeColor, font: linkEdgeFont } as any);
	edges.add({ id: inEdgeId, from: linkInId, to: toVisId, label: edgeLabel, color: linkEdgeColor, font: linkEdgeFont } as any);

	const pair: ILinkPair = {
		linkOutId: linkOutId,
		linkInId: linkInId,
		outEdgeId: outEdgeId,
		inEdgeId: inEdgeId,
		originalEdgeData: originalEdgeData,
		descriptor: descriptor,
		amount: itemAmount,
	};

	state.linkPairs.push(pair);
	return pair;
}

export function removeLinkPair(
	state: ICustomGraphState,
	pairIndex: number,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
): void {
	const pair = state.linkPairs[pairIndex];
	edges.remove(pair.outEdgeId);
	edges.remove(pair.inEdgeId);
	nodes.remove(pair.linkOutId);
	nodes.remove(pair.linkInId);
	edges.add(pair.originalEdgeData);
	state.linkPairs.splice(pairIndex, 1);
	state.saveGraphState();
}

export function recombineAllLinksForNode(
	state: ICustomGraphState,
	pairIndices: number[],
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
): void {
	const sorted = pairIndices.slice().sort((a, b) => b - a);
	for (const idx of sorted) {
		const pair = state.linkPairs[idx];
		if (!pair) { continue; }
		edges.remove(pair.outEdgeId);
		edges.remove(pair.inEdgeId);
		nodes.remove(pair.linkOutId);
		nodes.remove(pair.linkInId);
		edges.add(pair.originalEdgeData);
		state.linkPairs.splice(idx, 1);
	}
	state.saveGraphState();
}

export function handleEdgeDoubleClick(
	state: ICustomGraphState,
	visEdgeId: number,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
): void {
	if (state.linkPairs.some((p) => p.outEdgeId === visEdgeId || p.inEdgeId === visEdgeId)) {
		return;
	}

	const splitGroup = state.splitGroups.find((g) => g.splitEdgeIds.indexOf(visEdgeId) !== -1);
	if (splitGroup) {
		handleSplitEdgeDoubleClick(state, visEdgeId, splitGroup, nodes, edges, result);
		return;
	}

	const graphEdge = result.graph.edges.find((e) => e.id === visEdgeId);
	if (!graphEdge) { return; }

	const descriptor: ILinkNodeDescriptor = {
		fromNodeKey: getNodeKey(graphEdge.from),
		toNodeKey: getNodeKey(graphEdge.to),
		itemClassName: graphEdge.itemAmount.item,
	};

	if (state.linkPairs.some(
		(p) =>
			p.descriptor.fromNodeKey === descriptor.fromNodeKey &&
			p.descriptor.toNodeKey === descriptor.toNodeKey &&
			p.descriptor.itemClassName === descriptor.itemClassName,
	)) {
		return;
	}

	const originalEdgeData = edges.get(visEdgeId);
	if (!originalEdgeData) { return; }

	const positions = state.network.getPositions([graphEdge.from.id, graphEdge.to.id]);
	const fromPos = positions[graphEdge.from.id];
	const toPos = positions[graphEdge.to.id];
	if (!fromPos || !toPos) { return; }

	createLinkPair(
		state, nodes, edges,
		graphEdge.from.id, graphEdge.to.id,
		originalEdgeData, descriptor,
		graphEdge.itemAmount.item, graphEdge.itemAmount.amount,
		fromPos, toPos,
		getNodeDisplayName(graphEdge.from), getNodeDisplayName(graphEdge.to),
	);
	state.saveGraphState();
}

export function handleSplitEdgeDoubleClick(
	state: ICustomGraphState,
	visEdgeId: number,
	splitGroup: ISplitGroup,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
): void {
	const visEdge = edges.get(visEdgeId) as any;
	if (!visEdge) { return; }

	const fromId = visEdge.from as number;
	const toId = visEdge.to as number;

	const splitFromIndex = splitGroup.splitNodeIds.indexOf(fromId);
	const splitToIndex = splitGroup.splitNodeIds.indexOf(toId);
	const isSplitFrom = splitFromIndex !== -1;
	const splitNodeIndex = isSplitFrom ? splitFromIndex : splitToIndex;
	if (splitNodeIndex === -1) { return; }

	const recipeGraphNode = result.graph.nodes.find((n) => n.id === splitGroup.originalNodeId);
	if (!recipeGraphNode) { return; }
	const recipeKey = getNodeKey(recipeGraphNode);

	let graphFromId = isSplitFrom ? splitGroup.originalNodeId : fromId;
	let graphToId = isSplitFrom ? toId : splitGroup.originalNodeId;

	const otherSideVisId = isSplitFrom ? toId : fromId;
	let otherSplitGroup: ISplitGroup | null = null;
	let otherSplitNodeIndex = -1;
	for (const sg of state.splitGroups) {
		if (sg === splitGroup) { continue; }
		const otherIdx = sg.splitNodeIds.indexOf(otherSideVisId);
		if (otherIdx !== -1) {
			otherSplitGroup = sg;
			otherSplitNodeIndex = otherIdx;
			if (isSplitFrom) { graphToId = sg.originalNodeId; } else { graphFromId = sg.originalNodeId; }
			break;
		}
	}

	const candidateEdges = result.graph.edges.filter((e) => e.from.id === graphFromId && e.to.id === graphToId);
	let graphEdge = candidateEdges.length === 1 ? candidateEdges[0] : null;

	if (!graphEdge && candidateEdges.length > 1) {
		const visEdgeLabelFirstLine = ((visEdge.label || '') as string).split('\n')[0].trim();
		graphEdge = candidateEdges.find(
			(e) => model.getItem(e.itemAmount.item).prototype.name === visEdgeLabelFirstLine,
		) || null;
	}
	if (!graphEdge) { return; }

	const descriptor: ILinkNodeDescriptor = {
		fromNodeKey: getNodeKey(graphEdge.from),
		toNodeKey: getNodeKey(graphEdge.to),
		itemClassName: graphEdge.itemAmount.item,
		splitRecipeKey: recipeKey,
		splitNodeIndex: splitNodeIndex,
	};
	if (otherSplitGroup) {
		descriptor.otherSplitRecipeKey = otherSplitGroup.descriptor.recipeNodeKey;
		descriptor.otherSplitNodeIndex = otherSplitNodeIndex;
	}

	const existingPairIndex = state.linkPairs.findIndex(
		(p) =>
			p.descriptor.fromNodeKey === descriptor.fromNodeKey &&
			p.descriptor.toNodeKey === descriptor.toNodeKey &&
			p.descriptor.itemClassName === descriptor.itemClassName &&
			p.descriptor.splitRecipeKey === descriptor.splitRecipeKey &&
			p.descriptor.splitNodeIndex === descriptor.splitNodeIndex,
	);
	if (existingPairIndex !== -1) {
		const existingPair = state.linkPairs[existingPairIndex];
		if (
			existingPair.descriptor.otherSplitRecipeKey !== descriptor.otherSplitRecipeKey ||
			existingPair.descriptor.otherSplitNodeIndex !== descriptor.otherSplitNodeIndex
		) {
			removeLinkPair(state, existingPairIndex, nodes, edges);
		} else {
			return;
		}
	}

	const positions = state.network.getPositions([fromId, toId]);
	const fromPos = positions[fromId];
	const toPos = positions[toId];
	if (!fromPos || !toPos) { return; }

	const otherNodeId = isSplitFrom ? toId : fromId;
	const otherGraphNode = result.graph.nodes.find((n) => n.id === otherNodeId);
	const otherName = otherGraphNode ? getNodeDisplayName(otherGraphNode) : 'Node';
	const splitNodeData = nodes.get(isSplitFrom ? fromId : toId);
	const splitName = splitNodeData
		? ((splitNodeData.label || '') as string).replace(/<[^>]*>/g, '').split('\n')[0].trim() || 'Split Node'
		: 'Split Node';
	const fromDisplayName = isSplitFrom ? splitName : otherName;
	const toDisplayName = isSplitFrom ? otherName : splitName;

	let splitLinkAmount = graphEdge.itemAmount.amount;
	const splitItemClassName = splitGroup.descriptor.splitItemClassName;
	if (splitItemClassName) {
		const isOutputSplit = splitGroup.descriptor.splitType === 'output';
		const isPrimaryEdge =
			graphEdge.itemAmount.item === splitItemClassName &&
			(isOutputSplit
				? graphEdge.from.id === splitGroup.originalNodeId
				: graphEdge.to.id === splitGroup.originalNodeId);
		if (!isPrimaryEdge) {
			const splitItemEdges = result.graph.edges.filter(
				(e) =>
					(isOutputSplit ? e.from.id : e.to.id) === splitGroup.originalNodeId &&
					e.itemAmount.item === splitItemClassName,
			);
			const totalSplitAmount = splitItemEdges.reduce((sum, e) => sum + e.itemAmount.amount, 0);
			if (totalSplitAmount > 0 && splitNodeIndex < splitItemEdges.length) {
				const fraction = splitItemEdges[splitNodeIndex].itemAmount.amount / totalSplitAmount;
				splitLinkAmount = graphEdge.itemAmount.amount * fraction;
			}
		}
	}

	createLinkPair(
		state, nodes, edges,
		fromId, toId,
		visEdge, descriptor,
		graphEdge.itemAmount.item, splitLinkAmount,
		fromPos, toPos,
		fromDisplayName, toDisplayName,
	);
	state.saveGraphState();
}

export function handleNodeDoubleClick(
	state: ICustomGraphState,
	nodeId: number,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
): void {
	const graphNode = result.graph.nodes.find((n) => n.id === nodeId);
	if (
		graphNode &&
		(graphNode instanceof IntermediateNode ||
			graphNode instanceof InputNode ||
			graphNode instanceof MinerNode)
	) {
		const connectedEdges = result.graph.edges.filter(
			(e) => e.from.id === nodeId || e.to.id === nodeId,
		);
		let created = false;
		for (const graphEdge of connectedEdges) {
			const descriptor: ILinkNodeDescriptor = {
				fromNodeKey: getNodeKey(graphEdge.from),
				toNodeKey: getNodeKey(graphEdge.to),
				itemClassName: graphEdge.itemAmount.item,
			};
			const alreadyLinked = state.linkPairs.some(
				(p) =>
					p.descriptor.fromNodeKey === descriptor.fromNodeKey &&
					p.descriptor.toNodeKey === descriptor.toNodeKey &&
					p.descriptor.itemClassName === descriptor.itemClassName,
			);
			if (alreadyLinked) { continue; }
			if (state.linkPairs.some((p) => p.outEdgeId === graphEdge.id || p.inEdgeId === graphEdge.id)) {
				continue;
			}

			const originalEdgeData = edges.get(graphEdge.id);
			if (!originalEdgeData) {
				const otherNodeId = graphEdge.from.id === nodeId ? graphEdge.to.id : graphEdge.from.id;
				const splitGroup = state.splitGroups.find((g) => g.originalNodeId === otherNodeId);
				if (splitGroup) {
					const itemName = model.getItem(graphEdge.itemAmount.item).prototype.name;
					for (const splitEdgeId of splitGroup.splitEdgeIds) {
						const splitEdge = edges.get(splitEdgeId) as any;
						if (!splitEdge) { continue; }
						if (splitEdge.from !== nodeId && splitEdge.to !== nodeId) { continue; }
						const otherEnd = (splitEdge.from === nodeId ? splitEdge.to : splitEdge.from) as number;
						if (splitGroup.splitNodeIds.indexOf(otherEnd) === -1) { continue; }
						const labelFirstLine = ((splitEdge.label || '') as string).split('\n')[0].trim();
						if (labelFirstLine !== itemName) { continue; }
						handleSplitEdgeDoubleClick(state, splitEdgeId as number, splitGroup, nodes, edges, result);
						created = true;
					}
				}
				continue;
			}

			const positions = state.network.getPositions([graphEdge.from.id, graphEdge.to.id]);
			const fromPos = positions[graphEdge.from.id];
			const toPos = positions[graphEdge.to.id];
			if (!fromPos || !toPos) { continue; }

			createLinkPair(
				state, nodes, edges,
				graphEdge.from.id, graphEdge.to.id,
				originalEdgeData, descriptor,
				graphEdge.itemAmount.item, graphEdge.itemAmount.amount,
				fromPos, toPos,
				getNodeDisplayName(graphEdge.from), getNodeDisplayName(graphEdge.to),
			);
			created = true;
		}
		if (created) { state.saveGraphState(); }
	}
}

export function applyStoredLinks(
	state: ICustomGraphState,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
	descriptors: ILinkNodeDescriptor[],
): void {
	if (descriptors.length === 0) { return; }

	for (const descriptor of descriptors) {
		const graphEdge = result.graph.edges.find(
			(e) =>
				getNodeKey(e.from) === descriptor.fromNodeKey &&
				getNodeKey(e.to) === descriptor.toNodeKey &&
				e.itemAmount.item === descriptor.itemClassName,
		);
		if (!graphEdge) { continue; }

		if (descriptor.splitRecipeKey != null && descriptor.splitNodeIndex != null) {
			applyStoredSplitEdgeLink(state, descriptor, graphEdge, nodes, edges, result);
			continue;
		}

		const visEdge = edges.get(graphEdge.id);
		if (!visEdge) { continue; }

		const positions = state.network.getPositions([graphEdge.from.id, graphEdge.to.id]);
		const fromPos = positions[graphEdge.from.id];
		const toPos = positions[graphEdge.to.id];
		if (!fromPos || !toPos) { continue; }

		const pair = createLinkPair(
			state, nodes, edges,
			graphEdge.from.id, graphEdge.to.id,
			visEdge, descriptor,
			graphEdge.itemAmount.item, graphEdge.itemAmount.amount,
			fromPos, toPos,
			getNodeDisplayName(graphEdge.from), getNodeDisplayName(graphEdge.to),
		);

		if (descriptor.linkOutPos) {
			nodes.update({ id: pair.linkOutId, x: descriptor.linkOutPos.x, y: descriptor.linkOutPos.y });
		}
		if (descriptor.linkInPos) {
			nodes.update({ id: pair.linkInId, x: descriptor.linkInPos.x, y: descriptor.linkInPos.y });
		}
	}
}

export function applyStoredSplitEdgeLink(
	state: ICustomGraphState,
	descriptor: ILinkNodeDescriptor,
	graphEdge: any,
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
	result: ProductionResult,
	overrideAmount?: number,
): boolean {
	const splitGroup = state.splitGroups.find(
		(g) => g.descriptor.recipeNodeKey === descriptor.splitRecipeKey,
	);
	if (!splitGroup) { return false; }

	const splitNodeIndex = descriptor.splitNodeIndex!;
	if (splitNodeIndex < 0 || splitNodeIndex >= splitGroup.splitNodeIds.length) { return false; }
	const splitNodeId = splitGroup.splitNodeIds[splitNodeIndex];

	const isSplitFrom = descriptor.fromNodeKey === descriptor.splitRecipeKey;
	const otherKey = isSplitFrom ? descriptor.toNodeKey : descriptor.fromNodeKey;
	const otherGraphNode = result.graph.nodes.find((n) => getNodeKey(n) === otherKey);
	if (!otherGraphNode) { return false; }

	let otherVisNodeId = otherGraphNode.id;
	if (descriptor.otherSplitRecipeKey != null && descriptor.otherSplitNodeIndex != null) {
		const otherSplitGrp = state.splitGroups.find(
			(g) => g.descriptor.recipeNodeKey === descriptor.otherSplitRecipeKey,
		);
		if (otherSplitGrp && descriptor.otherSplitNodeIndex! < otherSplitGrp.splitNodeIds.length) {
			otherVisNodeId = otherSplitGrp.splitNodeIds[descriptor.otherSplitNodeIndex!];
		}
	}

	const itemName = model.getItem(descriptor.itemClassName).prototype.name;
	const matchingEdges = edges.get().filter((e: any) => {
		if (isSplitFrom) { return e.from === splitNodeId && e.to === otherVisNodeId; } else { return e.from === otherVisNodeId && e.to === splitNodeId; }
	});

	let visEdge: any = null;
	if (matchingEdges.length === 1) {
		visEdge = matchingEdges[0];
	} else if (matchingEdges.length > 1) {
		visEdge = matchingEdges.find((e: any) => {
			const labelFirstLine = ((e.label || '') as string).split('\n')[0].trim();
			return labelFirstLine === itemName;
		}) || matchingEdges[0];
	}
	if (!visEdge) { return false; }
	if (splitGroup.splitEdgeIds.indexOf(visEdge.id) === -1) { return false; }

	let linkAmount = graphEdge.itemAmount.amount;
	if (overrideAmount != null) {
		linkAmount = overrideAmount;
	} else {
		const splitItemClassName = splitGroup.descriptor.splitItemClassName;
		if (splitItemClassName) {
			const isOutputSplit = splitGroup.descriptor.splitType === 'output';
			const isPrimaryEdge =
				graphEdge.itemAmount.item === splitItemClassName &&
				(isOutputSplit
					? graphEdge.from.id === splitGroup.originalNodeId
					: graphEdge.to.id === splitGroup.originalNodeId);
			if (!isPrimaryEdge) {
				const splitItemEdges = result.graph.edges.filter(
					(e) =>
						(isOutputSplit ? e.from.id : e.to.id) === splitGroup.originalNodeId &&
						e.itemAmount.item === splitItemClassName,
				);
				const totalSplitAmount = splitItemEdges.reduce((sum, e) => sum + e.itemAmount.amount, 0);
				if (totalSplitAmount > 0 && splitNodeIndex < splitItemEdges.length) {
					const fraction = splitItemEdges[splitNodeIndex].itemAmount.amount / totalSplitAmount;
					linkAmount = graphEdge.itemAmount.amount * fraction;
				}
			}
		}
	}

	const fromNodeId = isSplitFrom ? splitNodeId : otherVisNodeId;
	const toNodeId = isSplitFrom ? otherVisNodeId : splitNodeId;
	const positions = state.network.getPositions([fromNodeId, toNodeId]);
	const fromPos = positions[fromNodeId];
	const toPos = positions[toNodeId];
	if (!fromPos || !toPos) { return false; }

	const otherVisNodeData = nodes.get(otherVisNodeId);
	const otherName =
		otherVisNodeId !== otherGraphNode.id && otherVisNodeData
			? ((otherVisNodeData.label || '') as string)
					.replace(/<[^>]*>/g, '')
					.split('\n')[0]
					.trim() || getNodeDisplayName(otherGraphNode)
			: getNodeDisplayName(otherGraphNode);
	const splitNodeData = nodes.get(splitNodeId);
	const splitName = splitNodeData
		? ((splitNodeData.label || '') as string).replace(/<[^>]*>/g, '').split('\n')[0].trim() || 'Split Node'
		: 'Split Node';
	const fromDisplayName = isSplitFrom ? splitName : otherName;
	const toDisplayName = isSplitFrom ? otherName : splitName;

	const pair = createLinkPair(
		state, nodes, edges,
		fromNodeId, toNodeId,
		visEdge, descriptor,
		graphEdge.itemAmount.item, linkAmount,
		fromPos, toPos,
		fromDisplayName, toDisplayName,
	);

	if (descriptor.linkOutPos) {
		nodes.update({ id: pair.linkOutId, x: descriptor.linkOutPos.x, y: descriptor.linkOutPos.y });
	}
	if (descriptor.linkInPos) {
		nodes.update({ id: pair.linkInId, x: descriptor.linkInPos.x, y: descriptor.linkInPos.y });
	}

	return true;
}
