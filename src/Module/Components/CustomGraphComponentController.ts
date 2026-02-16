import {DataSet, Network} from 'vis-network';
import {IController, IIntervalService, IPromise, IScope, ITimeoutService} from 'angular';
import ELK from 'elkjs/lib/elk.bundled';
import {IVisNode} from '@src/Tools/Production/Result/IVisNode';
import {IVisEdge} from '@src/Tools/Production/Result/IVisEdge';
import {IElkGraph} from '@src/Solver/IElkGraph';
import {Strings} from '@src/Utils/Strings';
import model from '@src/Data/Model';
import {ProductionResult} from '@src/Tools/Production/Result/ProductionResult';
import {GraphNode} from '@src/Tools/Production/Result/Nodes/GraphNode';
import {RecipeNode} from '@src/Tools/Production/Result/Nodes/RecipeNode';
import {InputNode} from '@src/Tools/Production/Result/Nodes/InputNode';
import {MinerNode} from '@src/Tools/Production/Result/Nodes/MinerNode';
import {ProductNode} from '@src/Tools/Production/Result/Nodes/ProductNode';
import {ByproductNode} from '@src/Tools/Production/Result/Nodes/ByproductNode';
import {SinkNode} from '@src/Tools/Production/Result/Nodes/SinkNode';
import {GeneratorNode} from '@src/Tools/Production/Result/Nodes/GeneratorNode';
import {IntermediateNode} from '@src/Tools/Production/Result/Nodes/IntermediateNode';
import {ILinkNodeDescriptor} from '@src/Tools/Production/IProductionData';

interface ILinkPair
{
	linkOutId: number;
	linkInId: number;
	outEdgeId: number;
	inEdgeId: number;
	originalEdgeData: any;
	descriptor: ILinkNodeDescriptor;
}

function getNodeKey(node: GraphNode): string
{
	if (node instanceof RecipeNode) {
		return 'recipe:' + node.recipeData.recipe.className;
	}
	if (node instanceof InputNode) {
		return 'input:' + node.itemAmount.item;
	}
	if (node instanceof MinerNode) {
		return 'miner:' + node.itemAmount.item;
	}
	if (node instanceof ProductNode) {
		return 'product:' + node.itemAmount.item;
	}
	if (node instanceof ByproductNode) {
		return 'byproduct:' + node.itemAmount.item;
	}
	if (node instanceof SinkNode) {
		return 'sink:' + node.itemAmount.item;
	}
	if (node instanceof GeneratorNode) {
		return 'generator:' + node.generatorData.fuel.className;
	}
	if (node instanceof IntermediateNode) {
		return 'intermediate:' + node.resource.className;
	}
	return 'node:' + node.id;
}

function getNodeDisplayName(node: GraphNode): string
{
	if (node instanceof RecipeNode) {
		return node.recipeData.recipe.name;
	}
	if (node instanceof InputNode) {
		return 'Input: ' + node.resource.name;
	}
	if (node instanceof MinerNode) {
		return node.resource.name;
	}
	if (node instanceof ProductNode) {
		return node.resource.name;
	}
	if (node instanceof ByproductNode) {
		return 'Byproduct: ' + node.resource.name;
	}
	if (node instanceof SinkNode) {
		return 'Sink: ' + node.resource.name;
	}
	if (node instanceof GeneratorNode) {
		return node.generatorData.fuel.name;
	}
	if (node instanceof IntermediateNode) {
		return node.resource.name;
	}
	return 'Node ' + node.id;
}

export class CustomGraphComponentController implements IController
{

public result: ProductionResult;
public tabId: string;
public frozen: boolean = false;
public exportMessage: string = '';

	public static $inject = ['$element', '$scope', '$timeout', '$interval'];

	private unregisterWatcherCallback: () => void;
	private unregisterTabIdWatcherCallback: () => void;
	private network: Network;
	private fitted: boolean = false;
	private interval: IPromise<any>;
	private frozenResult: ProductionResult|undefined;
	private graphContainer: HTMLElement;

// Link node tracking
private linkPairs: ILinkPair[] = [];
private linkNodeIdCounter: number = 100000;
private linkEdgeIdCounter: number = 200000;
private nodesDataSet: DataSet<IVisNode>|null = null;
private edgesDataSet: DataSet<IVisEdge>|null = null;
private currentResult: ProductionResult|null = null;

private static readonly POSITIONS_STORAGE_KEY = 'customGraphNodePositions';
private static readonly FROZEN_STORAGE_KEY = 'customGraphFrozenTabs';
private static readonly LINK_NODES_STORAGE_KEY = 'customGraphLinkNodes';

	public constructor(private readonly $element: any, private readonly $scope: IScope, private readonly $timeout: ITimeoutService, private readonly $interval: IIntervalService) {}

	public $onInit(): void
	{
		this.frozen = this.loadFrozenState();
		let initialRenderDone = false;

		// Watch for tab changes — reload frozen state for the new tab
		this.unregisterTabIdWatcherCallback = this.$scope.$watch(() => {
			return this.tabId;
		}, (newTabId, oldTabId) => {
			if (newTabId !== oldTabId) {
				// Save positions for the old tab before switching
				this.saveNodePositionsForTab(oldTabId);
				// Reload frozen state for the new tab
				this.frozen = this.loadFrozenState();
				// Need to re-render for the new tab
				initialRenderDone = false;
			}
		});

		this.unregisterWatcherCallback = this.$scope.$watch(() => {
			return this.result;
		}, (newValue) => {
			if (!initialRenderDone) {
				// Don't count undefined/null as the initial render
				if (!newValue) {
					return;
				}
				// Always render on first load, even if frozen
				initialRenderDone = true;
				this.frozenResult = newValue;
				this.updateData(newValue);
			} else if (!this.frozen) {
				this.frozenResult = newValue;
				this.updateData(newValue);
			}
		});

		const resizable = this.$element.parent();
		let lastHeight = resizable.height();

		this.interval = this.$interval(() => {
			const newHeight = resizable.height();
			if (newHeight !== lastHeight && this.network) {
				lastHeight = newHeight;
				this.network.setOptions({
					height: newHeight + 'px',
				});
				this.network.fit();
			}
		}, 100);
	}

	public $onDestroy(): void
	{
		this.saveNodePositions();
		this.unregisterWatcherCallback();
		this.unregisterTabIdWatcherCallback();
		this.$interval.cancel(this.interval);
	}

public autoArrange(): void
{
if (!this.network || !this.nodesDataSet || !this.edgesDataSet) {
return;
}

const nodes = this.nodesDataSet;
const edges = this.edgesDataSet;

const elkGraph: IElkGraph = {
id: 'root',
layoutOptions: {
'elk.algorithm': 'org.eclipse.elk.layered',
'org.eclipse.elk.layered.nodePlacement.favorStraightEdges': true as unknown as string,
'org.eclipse.elk.spacing.nodeNode': 40 + '',
},
children: [],
edges: [],
};

nodes.forEach((node) => {
elkGraph.children.push({
id: node.id.toString(),
width: 250,
height: 100,
});
});

edges.forEach((edge) => {
elkGraph.edges.push({
id: '',
source: edge.from.toString(),
target: edge.to.toString(),
});
});

const elk = new ELK();
elk.layout(elkGraph).then((data) => {
nodes.forEach((node) => {
const id = node.id;
if (data.children) {
for (const item of data.children) {
if (parseInt(item.id, 10) === id) {
nodes.update({
id: id,
x: item.x,
y: item.y,
});
return;
}
}
}
});

this.network.fit();
this.saveNodePositions();
if (this.linkPairs.length > 0) {
this.saveLinkNodes();
}
});
}

public exportGraph(): void
{
if (!this.network || !this.nodesDataSet || !this.edgesDataSet) {
return;
}

const positions = this.network.getPositions();
const nodesExport: any[] = [];
this.nodesDataSet.forEach((node: any) => {
const pos = positions[node.id] || {x: 0, y: 0};
nodesExport.push({
id: node.id,
label: node.label,
x: pos.x,
y: pos.y,
color: node.color,
font: node.font,
});
});

const edgesExport: any[] = [];
this.edgesDataSet.forEach((edge: any) => {
edgesExport.push({
id: edge.id,
from: edge.from,
to: edge.to,
label: edge.label,
color: edge.color,
font: edge.font,
smooth: edge.smooth,
});
});

const exportData = {
nodes: nodesExport,
edges: edgesExport,
};

const json = JSON.stringify(exportData, null, 2);

if (navigator.clipboard && navigator.clipboard.writeText) {
navigator.clipboard.writeText(json).then(() => {
this.$scope.$apply(() => {
this.exportMessage = 'Copied to clipboard!';
});
this.$timeout(() => {
this.exportMessage = '';
}, 3000);
});
} else {
const textarea = document.createElement('textarea');
textarea.value = json;
document.body.appendChild(textarea);
textarea.select();
document.execCommand('copy');
document.body.removeChild(textarea);
this.exportMessage = 'Copied to clipboard!';
this.$timeout(() => {
this.exportMessage = '';
}, 3000);
}
}

public toggleFreeze(): void
{
this.frozen = !this.frozen;
this.saveFrozenState();

if (!this.frozen) {
// Clear link nodes when unfreezing
this.linkPairs = [];
this.saveLinkNodesFromDescriptors([]);
this.frozenResult = this.result;
this.updateData(this.result);
}
}

	public updateData(result: ProductionResult|undefined): void
	{
		if (!result) {
			return;
		}

		this.fitted = false;
		this.useVis(result);
	}

	public useVis(result: ProductionResult): void
	{
		// Reset link tracking for fresh render
		this.linkPairs = [];
		this.linkNodeIdCounter = 100000;
		this.linkEdgeIdCounter = 200000;
		this.currentResult = result;

		const nodes = new DataSet<IVisNode>();
		const edges = new DataSet<IVisEdge>();
		this.nodesDataSet = nodes;
		this.edgesDataSet = edges;

		for (const node of result.graph.nodes) {
			nodes.add(node.getVisNode());
		}

		for (const edge of result.graph.edges) {
			const smooth: any = {
				enabled: false,
			};

			if (edge.to.hasOutputTo(edge.from)) {
				smooth.enabled = true;
				smooth.type = 'curvedCW';
				smooth.roundness = 0.2;
			}

			edges.add({
				id: edge.id,
				from: edge.from.id,
				to: edge.to.id,
				label: model.getItem(edge.itemAmount.item).prototype.name + '\n' + Strings.formatItemAmount(edge.itemAmount.amount, edge.itemAmount.item),
				color: {
					color: 'rgba(105, 125, 145, 1)',
					highlight: 'rgba(134, 151, 167, 1)',
				},
				font: {
					color: 'rgba(238, 238, 238, 1)',
				},
				smooth: smooth,
			} as any);
		}

		this.network = this.drawVisualisation(nodes, edges);

this.network.on('dragEnd', () => {
this.saveNodePositions();
if (this.linkPairs.length > 0) {
this.saveLinkNodes();
}
});

		// Always run ELK layout first (exactly like Visualization)
		this.$timeout(0).then(() => {
			const elkGraph: IElkGraph = {
				id: 'root',
				layoutOptions: {
					'elk.algorithm': 'org.eclipse.elk.layered',
					'org.eclipse.elk.layered.nodePlacement.favorStraightEdges': true as unknown as string,
					'org.eclipse.elk.spacing.nodeNode': 40 + '',
				},
				children: [],
				edges: [],
			};

			nodes.forEach((node) => {
				elkGraph.children.push({
					id: node.id.toString(),
					width: 250,
					height: 100,
				});
			});
			edges.forEach((edge) => {
				elkGraph.edges.push({
					id: '',
					source: edge.from.toString(),
					target: edge.to.toString(),
				});
			});

			this.$timeout(0).then(() => {
				const elk = new ELK();
				elk.layout(elkGraph).then((data) => {
					nodes.forEach((node) => {
						const id = node.id;
						if (data.children) {
							for (const item of data.children) {
								if (parseInt(item.id, 10) === id) {
									nodes.update({
										id: id,
										x: item.x,
										y: item.y,
									});
									return;
								}
							}
						}
					});

					if (!this.fitted) {
						this.fitted = true;
						this.network.fit();
					}

					// After ELK layout, restore saved positions if frozen and they match
					const savedPositions = this.loadNodePositions();
					if (this.frozen && this.savedPositionsMatchGraph(savedPositions, result)) {
						nodes.forEach((node) => {
							const id = node.id;
							if (savedPositions[id]) {
								nodes.update({
									id: id,
									x: savedPositions[id].x,
									y: savedPositions[id].y,
								});
							}
						});
						this.network.fit();
					}

					// Apply stored link nodes after layout/positions are set
					this.applyStoredLinks(nodes, edges, result, savedPositions);

					// Register double-click handler for link node creation/removal
					this.network.on('doubleClick', (params: any) => {
						if (params.nodes.length === 1) {
							this.handleNodeDoubleClick(params.nodes[0], nodes, edges);
						} else if (params.edges.length === 1 && params.nodes.length === 0) {
							this.handleEdgeDoubleClick(params.edges[0], nodes, edges, result);
						}
					});

					// Save positions after layout
					this.$timeout(100).then(() => {
						this.saveNodePositions();
					});
				});
			});
		});
	}

	// ==================== Link Node Methods ====================

	private handleEdgeDoubleClick(visEdgeId: number, nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
	{
		// Don't allow splitting a link edge
		if (this.linkPairs.some((p) => p.outEdgeId === visEdgeId || p.inEdgeId === visEdgeId)) {
			return;
		}

		// Find the graph edge by ID
		const graphEdge = result.graph.edges.find((e) => e.id === visEdgeId);
		if (!graphEdge) {
			return;
		}

		// Check if this edge is already split (same descriptor)
		const descriptor: ILinkNodeDescriptor = {
			fromNodeKey: getNodeKey(graphEdge.from),
			toNodeKey: getNodeKey(graphEdge.to),
			itemClassName: graphEdge.itemAmount.item,
		};

		if (this.linkPairs.some((p) =>
			p.descriptor.fromNodeKey === descriptor.fromNodeKey &&
			p.descriptor.toNodeKey === descriptor.toNodeKey &&
			p.descriptor.itemClassName === descriptor.itemClassName
		)) {
			return;
		}

		// Get the vis edge data for restoration later
		const originalEdgeData = edges.get(visEdgeId);
		if (!originalEdgeData) {
			return;
		}

		// Get node positions to calculate midpoint
		const positions = this.network.getPositions([graphEdge.from.id, graphEdge.to.id]);
		const fromPos = positions[graphEdge.from.id];
		const toPos = positions[graphEdge.to.id];
		if (!fromPos || !toPos) {
			return;
		}

		this.createLinkPair(
nodes, edges,
graphEdge.from.id, graphEdge.to.id,
originalEdgeData, descriptor,
graphEdge.itemAmount.item, graphEdge.itemAmount.amount,
fromPos, toPos,
graphEdge.from, graphEdge.to,
);

		this.saveLinkNodes();
		this.saveNodePositions();
	}

	private handleNodeDoubleClick(nodeId: number, nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>): void
	{
		const pairIndex = this.linkPairs.findIndex((p) => p.linkOutId === nodeId || p.linkInId === nodeId);
		if (pairIndex === -1) {
			return;
		}

		const pair = this.linkPairs[pairIndex];

		// Remove link edges
		edges.remove(pair.outEdgeId);
		edges.remove(pair.inEdgeId);

		// Remove link nodes
		nodes.remove(pair.linkOutId);
		nodes.remove(pair.linkInId);

		// Restore original edge
		edges.add(pair.originalEdgeData);

		// Remove from tracking
		this.linkPairs.splice(pairIndex, 1);

		this.saveLinkNodes();
		this.saveNodePositions();
	}

	private createLinkPair(
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		fromVisId: number,
		toVisId: number,
		originalEdgeData: any,
		descriptor: ILinkNodeDescriptor,
		itemClassName: string,
		itemAmount: number,
		fromPos: {x: number, y: number},
		toPos: {x: number, y: number},
		fromNode: GraphNode,
		toNode: GraphNode,
	): ILinkPair
	{
		const midX = (fromPos.x + toPos.x) / 2;
		const midY = (fromPos.y + toPos.y) / 2;
		const offset = 50;

		const itemName = model.getItem(itemClassName).prototype.name;
		const amountStr = Strings.formatItemAmount(itemAmount, itemClassName);
		const fromName = getNodeDisplayName(fromNode);
		const toName = getNodeDisplayName(toNode);

		const linkOutId = this.linkNodeIdCounter++;
		const linkInId = this.linkNodeIdCounter++;
		const outEdgeId = this.linkEdgeIdCounter++;
		const inEdgeId = this.linkEdgeIdCounter++;

		// Link Out node (connected from source)
		nodes.add({
			id: linkOutId,
			label: '<b>Link Out: ' + itemName + '</b>\n<i>From: ' + fromName + '</i>\n' + amountStr,
			x: midX - offset,
			y: midY,
			color: {
				border: 'rgba(0, 0, 0, 0)',
				background: 'rgba(50, 160, 160, 1)',
				highlight: {
					border: 'rgba(238, 238, 238, 1)',
					background: 'rgba(80, 190, 190, 1)',
				},
			},
			font: {
				color: 'rgba(238, 238, 238, 1)',
			},
		});

		// Link In node (connected to target)
		nodes.add({
			id: linkInId,
			label: '<b>Link In: ' + itemName + '</b>\n<i>To: ' + toName + '</i>\n' + amountStr,
			x: midX + offset,
			y: midY,
			color: {
				border: 'rgba(0, 0, 0, 0)',
				background: 'rgba(50, 160, 160, 1)',
				highlight: {
					border: 'rgba(238, 238, 238, 1)',
					background: 'rgba(80, 190, 190, 1)',
				},
			},
			font: {
				color: 'rgba(238, 238, 238, 1)',
			},
		});

		// Remove original edge
		edges.remove(originalEdgeData.id);

		// Edge label from original
		const edgeLabel = originalEdgeData.label || '';

		// Add link edges
		edges.add({
			id: outEdgeId,
			from: fromVisId,
			to: linkOutId,
			label: edgeLabel,
			color: {
				color: 'rgba(50, 160, 160, 0.8)',
				highlight: 'rgba(80, 190, 190, 1)',
			},
			font: {
				color: 'rgba(238, 238, 238, 1)',
			},
		} as any);

		edges.add({
			id: inEdgeId,
			from: linkInId,
			to: toVisId,
			label: edgeLabel,
			color: {
				color: 'rgba(50, 160, 160, 0.8)',
				highlight: 'rgba(80, 190, 190, 1)',
			},
			font: {
				color: 'rgba(238, 238, 238, 1)',
			},
		} as any);

const pair: ILinkPair = {
linkOutId: linkOutId,
linkInId: linkInId,
outEdgeId: outEdgeId,
inEdgeId: inEdgeId,
originalEdgeData: originalEdgeData,
descriptor: descriptor,
};

		this.linkPairs.push(pair);
		return pair;
	}

private applyStoredLinks(nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult, savedPositions: {[key: string]: {x: number, y: number}}): void
{
const descriptors = this.loadLinkNodes();
if (descriptors.length === 0) {
return;
}

// Load link node positions from separate storage
const linkNodePositions = this.loadLinkNodePositions();
const appliedDescriptors: ILinkNodeDescriptor[] = [];

for (const descriptor of descriptors) {
			// Find the matching graph edge
			const graphEdge = result.graph.edges.find((e) => {
				return getNodeKey(e.from) === descriptor.fromNodeKey
					&& getNodeKey(e.to) === descriptor.toNodeKey
					&& e.itemAmount.item === descriptor.itemClassName;
			});

			if (!graphEdge) {
				continue;
			}

			// Check edge still exists in vis DataSet
			const visEdge = edges.get(graphEdge.id);
			if (!visEdge) {
				continue;
			}

			// Get positions of from/to nodes
			const positions = this.network.getPositions([graphEdge.from.id, graphEdge.to.id]);
			const fromPos = positions[graphEdge.from.id];
			const toPos = positions[graphEdge.to.id];
			if (!fromPos || !toPos) {
				continue;
			}

			const pair = this.createLinkPair(
				nodes, edges,
				graphEdge.from.id, graphEdge.to.id,
				visEdge, descriptor,
				graphEdge.itemAmount.item, graphEdge.itemAmount.amount,
				fromPos, toPos,
				graphEdge.from, graphEdge.to,
			);

// Restore saved positions for link nodes from separate storage
if (descriptor.linkOutPos) {
nodes.update({
id: pair.linkOutId,
x: descriptor.linkOutPos.x,
y: descriptor.linkOutPos.y,
});
}
if (descriptor.linkInPos) {
nodes.update({
id: pair.linkInId,
x: descriptor.linkInPos.x,
y: descriptor.linkInPos.y,
});
}

			appliedDescriptors.push(descriptor);
		}

		// If some descriptors weren't applied (stale), save only the valid ones
		if (appliedDescriptors.length !== descriptors.length) {
			this.saveLinkNodesFromDescriptors(appliedDescriptors);
		}
	}

	// ==================== Link Node Persistence ====================

private saveLinkNodes(): void
{
// Capture current link node positions into descriptors before saving
if (this.network) {
for (const pair of this.linkPairs) {
const pos = this.network.getPositions([pair.linkOutId, pair.linkInId]);
if (pos[pair.linkOutId]) {
pair.descriptor.linkOutPos = pos[pair.linkOutId];
}
if (pos[pair.linkInId]) {
pair.descriptor.linkInPos = pos[pair.linkInId];
}
}
}
const descriptors = this.linkPairs.map((p) => p.descriptor);
this.saveLinkNodesFromDescriptors(descriptors);
}

	private saveLinkNodesFromDescriptors(descriptors: ILinkNodeDescriptor[]): void
	{
		try {
			let allLinks: {[key: string]: ILinkNodeDescriptor[]} = {};
			const existing = localStorage.getItem(CustomGraphComponentController.LINK_NODES_STORAGE_KEY);
			if (existing) {
				allLinks = JSON.parse(existing);
			}
			allLinks[this.tabId] = descriptors;
			localStorage.setItem(CustomGraphComponentController.LINK_NODES_STORAGE_KEY, JSON.stringify(allLinks));
		} catch (e) {
			// ignore
		}
	}

private loadLinkNodes(): ILinkNodeDescriptor[]
{
try {
const stored = localStorage.getItem(CustomGraphComponentController.LINK_NODES_STORAGE_KEY);
if (stored) {
const allLinks = JSON.parse(stored);
if (allLinks[this.tabId]) {
return allLinks[this.tabId];
}
}
} catch (e) {
// ignore
}
return [];
}

private saveLinkNodePositions(): void
{
if (!this.network || !this.tabId) {
return;
}
try {
const rawPositions = this.network.getPositions();
const linkPositions: {[key: string]: {x: number, y: number}} = {};
for (const pair of this.linkPairs) {
if (rawPositions[pair.linkOutId]) {
linkPositions[pair.linkOutId] = rawPositions[pair.linkOutId];
}
if (rawPositions[pair.linkInId]) {
linkPositions[pair.linkInId] = rawPositions[pair.linkInId];
}
}
let allLinkPositions: {[key: string]: any} = {};
const existing = localStorage.getItem('customGraphLinkNodePositions');
if (existing) {
allLinkPositions = JSON.parse(existing);
}
allLinkPositions[this.tabId] = linkPositions;
localStorage.setItem('customGraphLinkNodePositions', JSON.stringify(allLinkPositions));
} catch (e) {
// ignore
}
}

private loadLinkNodePositions(): {[key: string]: {x: number, y: number}}
{
try {
const stored = localStorage.getItem('customGraphLinkNodePositions');
if (stored) {
const allLinkPositions = JSON.parse(stored);
if (allLinkPositions[this.tabId]) {
return allLinkPositions[this.tabId];
}
}
} catch (e) {
// ignore
}
return {};
}

	// ==================== Existing Methods ====================

	private loadFrozenState(): boolean
	{
		try {
			const allFrozen = localStorage.getItem(CustomGraphComponentController.FROZEN_STORAGE_KEY);
			if (allFrozen) {
				const map = JSON.parse(allFrozen);
				return map[this.tabId] === true;
			}
		} catch (e) {
			// ignore
		}
		return false;
	}

	private saveFrozenState(): void
	{
		try {
			let map: {[key: string]: boolean} = {};
			const existing = localStorage.getItem(CustomGraphComponentController.FROZEN_STORAGE_KEY);
			if (existing) {
				map = JSON.parse(existing);
			}
			map[this.tabId] = this.frozen;
			localStorage.setItem(CustomGraphComponentController.FROZEN_STORAGE_KEY, JSON.stringify(map));
		} catch (e) {
			// ignore
		}
	}

	private saveNodePositions(): void
	{
		this.saveNodePositionsForTab(this.tabId);
	}

private saveNodePositionsForTab(tabId: string): void
{
if (!this.network || !tabId) {
return;
}
try {
let allPositions: {[key: string]: any} = {};
const existing = localStorage.getItem(CustomGraphComponentController.POSITIONS_STORAGE_KEY);
if (existing) {
allPositions = JSON.parse(existing);
}
// Get all positions and filter out link node IDs (>=100000) to keep storage clean
const rawPositions = this.network.getPositions();
const filteredPositions: {[key: string]: {x: number, y: number}} = {};
for (const key in rawPositions) {
if (rawPositions.hasOwnProperty(key) && parseInt(key, 10) < 100000) {
filteredPositions[key] = rawPositions[key];
}
}
allPositions[tabId] = filteredPositions;
// Also save link node positions separately if links exist
if (this.linkPairs.length > 0) {
this.saveLinkNodePositions();
}
localStorage.setItem(CustomGraphComponentController.POSITIONS_STORAGE_KEY, JSON.stringify(allPositions));
} catch (e) {
// ignore storage errors
}
}

	private loadNodePositions(): {[key: string]: {x: number, y: number}}
	{
		try {
			const stored = localStorage.getItem(CustomGraphComponentController.POSITIONS_STORAGE_KEY);
			if (stored) {
				const allPositions = JSON.parse(stored);
				if (allPositions[this.tabId]) {
					return allPositions[this.tabId];
				}
			}
		} catch (e) {
			// ignore
		}
		return {};
	}

	private savedPositionsMatchGraph(savedPositions: {[key: string]: {x: number, y: number}}, result: ProductionResult): boolean
	{
		if (Object.keys(savedPositions).length === 0) {
			return false;
		}
		return result.graph.nodes.every((node) => {
			return savedPositions[node.id] !== undefined;
		});
	}

	private getGraphContainer(): HTMLElement
	{
		if (!this.graphContainer) {
			this.graphContainer = this.$element[0].querySelector('.custom-graph-container');
		}
		return this.graphContainer;
	}

	private drawVisualisation(nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>): Network
	{
		return new Network(this.getGraphContainer(), {
			nodes: nodes,
			edges: edges,
		}, {
			height: '800px',
			edges: {
				labelHighlightBold: false,
				font: {
					size: 14,
					multi: 'html',
					strokeColor: 'rgba(0, 0, 0, 0.2)',
				},
				arrows: 'to',
				smooth: false,
			},
			nodes: {
				labelHighlightBold: false,
				font: {
					size: 14,
					multi: 'html',
				},
				margin: {
					top: 10,
					left: 10,
					right: 10,
					bottom: 10,
				},
				shape: 'box',
				widthConstraint: {
					minimum: 50,
					maximum: 250,
				},
			},
			physics: {
				enabled: false,
			},
			layout: {
				improvedLayout: false,
				hierarchical: false,
			},
			interaction: {
				tooltipDelay: 0,
			},
		});
	}

}