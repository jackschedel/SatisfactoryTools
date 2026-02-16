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
import {Numbers} from '@src/Utils/Numbers';
import {RecipeData} from '@src/Tools/Production/Result/RecipeData';
import {MachineGroup} from '@src/Tools/Production/Result/MachineGroup';

interface ILinkPair
{
linkOutId: number;
linkInId: number;
outEdgeId: number;
inEdgeId: number;
originalEdgeData: any;
descriptor: ILinkNodeDescriptor;
}

interface ISplitDescriptor
{
recipeNodeKey: string;
splitType: 'output' | 'input';
splitNodePositions?: {[index: string]: {x: number, y: number}};
}

interface ISplitGroup
{
originalNodeId: number;
originalNodeData: any;
originalEdgesData: any[];
splitNodeIds: number[];
splitEdgeIds: number[];
descriptor: ISplitDescriptor;
}

interface ICombinedLinkDescriptor
{
type: 'out' | 'in';
itemClassName: string;
sourceKey: string;
originalDescriptors: ILinkNodeDescriptor[];
combinedOutPos?: {x: number, y: number};
combinedInPos?: {x: number, y: number};
}

interface ICombinedLinkGroup
{
type: 'out' | 'in';
itemClassName: string;
sourceKey: string;
originalPairs: ILinkPair[];
combinedOutId: number;
combinedInId: number;
combinedEdgeIds: number[];
descriptor: ICombinedLinkDescriptor;
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

	// Split node tracking
	private splitGroups: ISplitGroup[] = [];
	private splitNodeIdCounter: number = 300000;
	private splitEdgeIdCounter: number = 400000;

// Combined link tracking
private combinedLinkGroups: ICombinedLinkGroup[] = [];
private combinedNodeIdCounter: number = 500000;
private combinedEdgeIdCounter: number = 600000;

// Shift-click multi-select tracking
private shiftSelectedNodes: number[] = [];

	private static readonly POSITIONS_STORAGE_KEY = 'customGraphNodePositions';
	private static readonly FROZEN_STORAGE_KEY = 'customGraphFrozenTabs';
	private static readonly LINK_NODES_STORAGE_KEY = 'customGraphLinkNodes';
	private static readonly SPLIT_NODES_STORAGE_KEY = 'customGraphSplitNodes';
	private static readonly COMBINED_LINKS_STORAGE_KEY = 'customGraphCombinedLinks';

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
				if (this.splitGroups.length > 0) {
					this.saveSplitNodes();
				}
				if (this.combinedLinkGroups.length > 0) {
					this.saveCombinedLinks();
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
			// Clear split nodes when unfreezing
			this.splitGroups = [];
			this.saveSplitNodesFromDescriptors([]);
			// Clear combined links when unfreezing
			this.combinedLinkGroups = [];
			this.saveCombinedLinksFromDescriptors([]);
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
		// Reset split tracking for fresh render
		this.splitGroups = [];
		this.splitNodeIdCounter = 300000;
		this.splitEdgeIdCounter = 400000;
		// Reset combined link tracking for fresh render
		this.combinedLinkGroups = [];
		this.combinedNodeIdCounter = 500000;
		this.combinedEdgeIdCounter = 600000;
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
			if (this.splitGroups.length > 0) {
				this.saveSplitNodes();
			}
			if (this.combinedLinkGroups.length > 0) {
				this.saveCombinedLinks();
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

					// Apply stored split nodes after layout/positions are set
					this.applyStoredSplits(nodes, edges, result);

					// Apply stored combined links after layout/positions are set
					this.applyStoredCombinedLinks(nodes, edges, result);

// Register shift-click handler for multi-select
this.network.on('click', (params: any) => {
const isShift = params.event && params.event.srcEvent && params.event.srcEvent.shiftKey;
if (isShift && params.nodes.length === 1) {
const clickedNodeId = params.nodes[0] as number;
const idx = this.shiftSelectedNodes.indexOf(clickedNodeId);
if (idx !== -1) {
// Already selected, deselect it
this.shiftSelectedNodes.splice(idx, 1);
} else {
this.shiftSelectedNodes.push(clickedNodeId);
}
this.network.selectNodes(this.shiftSelectedNodes);
} else if (!isShift) {
// Clear shift selection on normal click
if (params.nodes.length === 1) {
this.shiftSelectedNodes = [params.nodes[0] as number];
} else {
this.shiftSelectedNodes = [];
}
}
});

// Register double-click handler for link node and split node creation/removal
this.network.on('doubleClick', (params: any) => {
const isShift = params.event && params.event.srcEvent && params.event.srcEvent.shiftKey;
if (params.nodes.length === 1) {
this.handleNodeDoubleClick(params.nodes[0], nodes, edges, result, isShift);
} else if (params.edges.length === 1 && params.nodes.length === 0) {
this.handleEdgeDoubleClick(params.edges[0], nodes, edges, result);
}
});

// Register right-click handler for combining link nodes
this.network.on('oncontext', (params: any) => {
params.event.preventDefault();
let selectedNodeIds = this.network.getSelectedNodes() as number[];
// Fall back to shift-selected nodes if network selection is empty/single
if (selectedNodeIds.length < 2 && this.shiftSelectedNodes.length >= 2) {
selectedNodeIds = this.shiftSelectedNodes.slice();
}
if (selectedNodeIds.length >= 2) {
this.handleCombineLinks(selectedNodeIds, nodes, edges, result);
this.shiftSelectedNodes = [];
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

// Don't allow splitting a split edge
if (this.splitGroups.some((g) => g.splitEdgeIds.indexOf(visEdgeId) !== -1)) {
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

	private handleNodeDoubleClick(nodeId: number, nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult, isShift: boolean = false): void
	{
		// Check if it's a combined link node being uncombined
		const combinedGroupIndex = this.combinedLinkGroups.findIndex((g) => g.combinedOutId === nodeId || g.combinedInId === nodeId);
		if (combinedGroupIndex !== -1) {
			this.uncombineCombinedGroup(combinedGroupIndex, nodes, edges, result);
			return;
		}

		// Check if it's a split node being combined back
		const splitGroupIndex = this.splitGroups.findIndex((g) => g.splitNodeIds.indexOf(nodeId) !== -1);
		if (splitGroupIndex !== -1) {
			this.combineSplitGroup(splitGroupIndex, nodes, edges);
			return;
		}

		// Check if it's a link node being removed
		const pairIndex = this.linkPairs.findIndex((p) => p.linkOutId === nodeId || p.linkInId === nodeId);
if (pairIndex !== -1) {
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
return;
}

// Check if it's a RecipeNode — handle split
const graphNode = result.graph.nodes.find((n) => n.id === nodeId);
if (graphNode && graphNode instanceof RecipeNode) {
if (isShift) {
this.splitRecipeByInput(nodeId, graphNode, nodes, edges, result);
} else {
this.splitRecipeByOutput(nodeId, graphNode, nodes, edges, result);
}
return;
}

// Check if it's an IntermediateNode — auto-create links for all its edges
if (graphNode && graphNode instanceof IntermediateNode) {
const connectedEdges = result.graph.edges.filter((e) => e.from.id === nodeId || e.to.id === nodeId);
let created = false;
for (const graphEdge of connectedEdges) {
// Skip edges that are already split
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
continue;
}

// Don't allow splitting a link edge
if (this.linkPairs.some((p) => p.outEdgeId === graphEdge.id || p.inEdgeId === graphEdge.id)) {
continue;
}

const originalEdgeData = edges.get(graphEdge.id);
if (!originalEdgeData) {
continue;
}

const positions = this.network.getPositions([graphEdge.from.id, graphEdge.to.id]);
const fromPos = positions[graphEdge.from.id];
const toPos = positions[graphEdge.to.id];
if (!fromPos || !toPos) {
continue;
}

this.createLinkPair(
nodes, edges,
graphEdge.from.id, graphEdge.to.id,
originalEdgeData, descriptor,
graphEdge.itemAmount.item, graphEdge.itemAmount.amount,
fromPos, toPos,
graphEdge.from, graphEdge.to,
);
created = true;
}

if (created) {
this.saveLinkNodes();
this.saveNodePositions();
}
}
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
label: '<b>Link Out: ' + itemName + '</b>\n<i>To: ' + toName + '</i>\n' + amountStr,
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
label: '<b>Link In: ' + itemName + '</b>\n<i>From: ' + fromName + '</i>\n' + amountStr,
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

	// ==================== Combined Link Methods ====================

	private handleCombineLinks(selectedNodeIds: number[], nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
	{
		// Find which link pairs correspond to the selected nodes
		const selectedOutPairs: ILinkPair[] = [];
		const selectedInPairs: ILinkPair[] = [];

		for (const nodeId of selectedNodeIds) {
			const pair = this.linkPairs.find((p) => p.linkOutId === nodeId);
			if (pair) {
				selectedOutPairs.push(pair);
				continue;
			}
			const inPair = this.linkPairs.find((p) => p.linkInId === nodeId);
			if (inPair) {
				selectedInPairs.push(inPair);
			}
		}

		// Try to combine Link Out nodes
		if (selectedOutPairs.length >= 2) {
			this.tryCombinePairs(selectedOutPairs, 'out', nodes, edges, result);
			return;
		}

		// Try to combine Link In nodes
		if (selectedInPairs.length >= 2) {
			this.tryCombinePairs(selectedInPairs, 'in', nodes, edges, result);
			return;
		}
	}

	private tryCombinePairs(pairs: ILinkPair[], type: 'out' | 'in', nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
	{
		// Group by item and source key
		// For OUT: group by itemClassName and toNodeKey (same destination)
		// For IN: group by itemClassName and fromNodeKey (same source)
		const groups: {[key: string]: ILinkPair[]} = {};

		for (const pair of pairs) {
			let groupKey: string;
			if (type === 'out') {
				groupKey = pair.descriptor.itemClassName + '||' + pair.descriptor.toNodeKey;
			} else {
				groupKey = pair.descriptor.itemClassName + '||' + pair.descriptor.fromNodeKey;
			}
			if (!groups[groupKey]) {
				groups[groupKey] = [];
			}
			groups[groupKey].push(pair);
		}

		// Combine each group that has 2+ pairs
		for (const key in groups) {
			if (groups.hasOwnProperty(key) && groups[key].length >= 2) {
				this.combineLinksGroup(groups[key], type, nodes, edges, result);
			}
		}
	}

	private combineLinksGroup(pairs: ILinkPair[], type: 'out' | 'in', nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
	{
		const itemClassName = pairs[0].descriptor.itemClassName;
		const itemName = model.getItem(itemClassName).prototype.name;
		const sourceKey = type === 'out' ? pairs[0].descriptor.toNodeKey : pairs[0].descriptor.fromNodeKey;
		const recipeCount = pairs.length;

		// Gather edge data from each pair before removal
		const pairEdgeData: {fromVisId: number, toVisId: number, outLabel: string, inLabel: string, amount: number}[] = [];
		let totalAmount = 0;

		for (const pair of pairs) {
			const outEdge = edges.get(pair.outEdgeId) as any;
			const inEdge = edges.get(pair.inEdgeId) as any;
			if (!outEdge || !inEdge) {
				continue;
			}

			const fromVisId = outEdge.from;
			const toVisId = inEdge.to;

			// Try to get amount from graph edge
			let amount = 0;
			const graphEdge = result.graph.edges.find((e) => {
				return getNodeKey(e.from) === pair.descriptor.fromNodeKey
					&& getNodeKey(e.to) === pair.descriptor.toNodeKey
					&& e.itemAmount.item === pair.descriptor.itemClassName;
			});
			if (graphEdge) {
				amount = graphEdge.itemAmount.amount;
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

		// Get position of first pair's relevant node for placement
		const firstPair = pairs[0];
		let combinedOutPos: {x: number, y: number};
		let combinedInPos: {x: number, y: number};

		if (type === 'out') {
			const outPos = this.network.getPositions([firstPair.linkOutId]);
			const inPos = this.network.getPositions([firstPair.linkInId]);
			combinedOutPos = outPos[firstPair.linkOutId] || {x: 0, y: 0};
			combinedInPos = inPos[firstPair.linkInId] || {x: 0, y: 0};
		} else {
			const outPos = this.network.getPositions([firstPair.linkOutId]);
			const inPos = this.network.getPositions([firstPair.linkInId]);
			combinedOutPos = outPos[firstPair.linkOutId] || {x: 0, y: 0};
			combinedInPos = inPos[firstPair.linkInId] || {x: 0, y: 0};
		}

		// Remove all the individual link pairs (nodes and edges)
		const removedPairs: ILinkPair[] = [];
		for (const pair of pairs) {
			edges.remove(pair.outEdgeId);
			edges.remove(pair.inEdgeId);
			nodes.remove(pair.linkOutId);
			nodes.remove(pair.linkInId);

			// Remove from linkPairs tracking
			const idx = this.linkPairs.indexOf(pair);
			if (idx !== -1) {
				this.linkPairs.splice(idx, 1);
			}
			removedPairs.push(pair);
		}

		// Determine labels
		const amountStr = Strings.formatItemAmount(totalAmount, itemClassName);
		let sourceName: string;

		// Find the source display name from graph nodes
		const sourceGraphNode = result.graph.nodes.find((n) => getNodeKey(n) === sourceKey);
		sourceName = sourceGraphNode ? getNodeDisplayName(sourceGraphNode) : sourceKey;

		let outLabel: string;
		let inLabel: string;

		if (type === 'out') {
			// Selected were Link Out nodes with same "To" destination
			outLabel = '<b>Link Out: ' + itemName + '</b>\n<i>To: ' + sourceName + '</i>\n' + amountStr;
			inLabel = '<b>Link In: ' + itemName + '</b>\n<i>From: (' + recipeCount + ' recipes)</i>\n' + amountStr;
		} else {
			// Selected were Link In nodes with same "From" source
			outLabel = '<b>Link Out: ' + itemName + '</b>\n<i>To: (' + recipeCount + ' recipes)</i>\n' + amountStr;
			inLabel = '<b>Link In: ' + itemName + '</b>\n<i>From: ' + sourceName + '</i>\n' + amountStr;
		}

		// Create combined nodes
		const combinedOutId = this.combinedNodeIdCounter++;
		const combinedInId = this.combinedNodeIdCounter++;
		const combinedEdgeIds: number[] = [];

		nodes.add({
			id: combinedOutId,
			label: outLabel,
			x: combinedOutPos.x,
			y: combinedOutPos.y,
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

		nodes.add({
			id: combinedInId,
			label: inLabel,
			x: combinedInPos.x,
			y: combinedInPos.y,
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

		const linkEdgeColor = {
			color: 'rgba(50, 160, 160, 0.8)',
			highlight: 'rgba(80, 190, 190, 1)',
		};
		const linkEdgeFont = {
			color: 'rgba(238, 238, 238, 1)',
		};

		if (type === 'out') {
			// Multiple sources → combined Link Out node
			for (const data of pairEdgeData) {
				const edgeId = this.combinedEdgeIdCounter++;
				combinedEdgeIds.push(edgeId);
				edges.add({
					id: edgeId,
					from: data.fromVisId,
					to: combinedOutId,
					label: data.outLabel,
					color: linkEdgeColor,
					font: linkEdgeFont,
				} as any);
			}
			// Combined Link In node → single target
			const targetId = pairEdgeData[0].toVisId;
			const inEdgeId = this.combinedEdgeIdCounter++;
			combinedEdgeIds.push(inEdgeId);
			edges.add({
				id: inEdgeId,
				from: combinedInId,
				to: targetId,
				label: itemName + '\n' + amountStr,
				color: linkEdgeColor,
				font: linkEdgeFont,
			} as any);
		} else {
			// Single source → combined Link Out node
			const sourceId = pairEdgeData[0].fromVisId;
			const outEdgeId = this.combinedEdgeIdCounter++;
			combinedEdgeIds.push(outEdgeId);
			edges.add({
				id: outEdgeId,
				from: sourceId,
				to: combinedOutId,
				label: itemName + '\n' + amountStr,
				color: linkEdgeColor,
				font: linkEdgeFont,
			} as any);
			// Combined Link In node → multiple targets
			for (const data of pairEdgeData) {
				const edgeId = this.combinedEdgeIdCounter++;
				combinedEdgeIds.push(edgeId);
				edges.add({
					id: edgeId,
					from: combinedInId,
					to: data.toVisId,
					label: data.inLabel,
					color: linkEdgeColor,
					font: linkEdgeFont,
				} as any);
			}
		}

		const descriptor: ICombinedLinkDescriptor = {
			type: type,
			itemClassName: itemClassName,
			sourceKey: sourceKey,
			originalDescriptors: removedPairs.map((p) => ({...p.descriptor})),
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

		this.combinedLinkGroups.push(group);
		this.network.unselectAll();
		this.saveCombinedLinks();
		this.saveLinkNodes();
		this.saveNodePositions();
	}

	private uncombineCombinedGroup(groupIndex: number, nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
	{
		const group = this.combinedLinkGroups[groupIndex];

		// Remove combined edges
		for (const edgeId of group.combinedEdgeIds) {
			edges.remove(edgeId);
		}

		// Remove combined nodes
		nodes.remove(group.combinedOutId);
		nodes.remove(group.combinedInId);

		// Recreate the individual link pairs
		for (const originalPair of group.originalPairs) {
			const desc = originalPair.descriptor;

			// Find the matching graph edge
			const graphEdge = result.graph.edges.find((e) => {
				return getNodeKey(e.from) === desc.fromNodeKey
					&& getNodeKey(e.to) === desc.toNodeKey
					&& e.itemAmount.item === desc.itemClassName;
			});

			if (!graphEdge) {
				// Restore original edge data if possible
				if (originalPair.originalEdgeData) {
					edges.add(originalPair.originalEdgeData);
				}
				continue;
			}

			const positions = this.network.getPositions([graphEdge.from.id, graphEdge.to.id]);
			const fromPos = positions[graphEdge.from.id] || {x: 0, y: 0};
			const toPos = positions[graphEdge.to.id] || {x: 0, y: 0};

			// The original edge was already removed from the vis DataSet; we need to recreate it
			// but createLinkPair expects it in the edges DataSet. Add it temporarily.
			edges.add(originalPair.originalEdgeData);

			const newPair = this.createLinkPair(
				nodes, edges,
				graphEdge.from.id, graphEdge.to.id,
				originalPair.originalEdgeData, desc,
				graphEdge.itemAmount.item, graphEdge.itemAmount.amount,
				fromPos, toPos,
				graphEdge.from, graphEdge.to,
			);

			// Restore saved positions if available
			if (desc.linkOutPos) {
				nodes.update({id: newPair.linkOutId, x: desc.linkOutPos.x, y: desc.linkOutPos.y});
			}
			if (desc.linkInPos) {
				nodes.update({id: newPair.linkInId, x: desc.linkInPos.x, y: desc.linkInPos.y});
			}
		}

		// Remove from tracking
		this.combinedLinkGroups.splice(groupIndex, 1);

		this.saveCombinedLinks();
		this.saveLinkNodes();
		this.saveNodePositions();
	}

	private applyStoredCombinedLinks(nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
	{
		const descriptors = this.loadCombinedLinks();
		if (descriptors.length === 0) {
			return;
		}

		const appliedDescriptors: ICombinedLinkDescriptor[] = [];

		for (const descriptor of descriptors) {
			// Find the link pairs that match the original descriptors
			const matchingPairs: ILinkPair[] = [];

			for (const origDesc of descriptor.originalDescriptors) {
				const pair = this.linkPairs.find((p) =>
					p.descriptor.fromNodeKey === origDesc.fromNodeKey
					&& p.descriptor.toNodeKey === origDesc.toNodeKey
					&& p.descriptor.itemClassName === origDesc.itemClassName
				);
				if (pair) {
					matchingPairs.push(pair);
				}
			}

			if (matchingPairs.length < 2) {
				continue;
			}

			// Combine them
			this.combineLinksGroup(matchingPairs, descriptor.type, nodes, edges, result);

			// Restore saved positions for the combined nodes
			const group = this.combinedLinkGroups[this.combinedLinkGroups.length - 1];
			if (group) {
				if (descriptor.combinedOutPos) {
					nodes.update({id: group.combinedOutId, x: descriptor.combinedOutPos.x, y: descriptor.combinedOutPos.y});
				}
				if (descriptor.combinedInPos) {
					nodes.update({id: group.combinedInId, x: descriptor.combinedInPos.x, y: descriptor.combinedInPos.y});
				}
			}

			appliedDescriptors.push(descriptor);
		}

		if (appliedDescriptors.length !== descriptors.length) {
			this.saveCombinedLinksFromDescriptors(appliedDescriptors);
		}
	}

	// ==================== Combined Link Persistence ====================

	private saveCombinedLinks(): void
	{
		if (this.network) {
			for (const group of this.combinedLinkGroups) {
				const pos = this.network.getPositions([group.combinedOutId, group.combinedInId]);
				if (pos[group.combinedOutId]) {
					group.descriptor.combinedOutPos = pos[group.combinedOutId];
				}
				if (pos[group.combinedInId]) {
					group.descriptor.combinedInPos = pos[group.combinedInId];
				}
			}
		}
		const descriptors = this.combinedLinkGroups.map((g) => g.descriptor);
		this.saveCombinedLinksFromDescriptors(descriptors);
	}

	private saveCombinedLinksFromDescriptors(descriptors: ICombinedLinkDescriptor[]): void
	{
		try {
			let allCombined: {[key: string]: ICombinedLinkDescriptor[]} = {};
			const existing = localStorage.getItem(CustomGraphComponentController.COMBINED_LINKS_STORAGE_KEY);
			if (existing) {
				allCombined = JSON.parse(existing);
			}
			allCombined[this.tabId] = descriptors;
			localStorage.setItem(CustomGraphComponentController.COMBINED_LINKS_STORAGE_KEY, JSON.stringify(allCombined));
		} catch (e) {
			// ignore
		}
	}

	private loadCombinedLinks(): ICombinedLinkDescriptor[]
	{
		try {
			const stored = localStorage.getItem(CustomGraphComponentController.COMBINED_LINKS_STORAGE_KEY);
			if (stored) {
				const allCombined = JSON.parse(stored);
				if (allCombined[this.tabId]) {
					return allCombined[this.tabId];
				}
			}
		} catch (e) {
			// ignore
		}
		return [];
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

// ==================== Split Node Methods ====================

	private splitRecipeByOutput(nodeId: number, recipeNode: RecipeNode, nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
	{
		// Only allow split if recipe has exactly 1 product item type
		if (recipeNode.recipeData.recipe.products.length !== 1) {
			return;
		}

		// Find output edges from this node in the graph
		const outputEdges = result.graph.edges.filter((e) => e.from.id === nodeId);
		// If 1 or fewer outputs, nothing to split
		if (outputEdges.length <= 1) {
			return;
		}

		// Check this node isn't already part of a split group
		if (this.splitGroups.some((g) => g.originalNodeId === nodeId)) {
			return;
		}

		// Gather all vis edges connected to this node
		const allVisEdges = this.getVisEdgesForNode(nodeId, edges);
		// Separate into input edges and output edges
		const visOutputEdges = allVisEdges.filter((e: any) => e.from === nodeId);
		const visInputEdges = allVisEdges.filter((e: any) => e.to === nodeId);

		// Save original node data
		const originalNodeData = nodes.get(nodeId);
		if (!originalNodeData) {
			return;
		}

		// Save all original edge data
		const originalEdgesData = allVisEdges.map((e: any) => ({...e}));

		// Get original node position
		const positions = this.network.getPositions([nodeId]);
		const originalPos = positions[nodeId] || {x: 0, y: 0};

		const recipeKey = getNodeKey(recipeNode);
		const descriptor: ISplitDescriptor = {
			recipeNodeKey: recipeKey,
			splitType: 'output',
		};

		const splitNodeIds: number[] = [];
		const splitEdgeIds: number[] = [];

		// Calculate total output amount across all output edges
		const totalOutputAmount = outputEdges.reduce((sum, e) => sum + e.itemAmount.amount, 0);

		// Build a map from vis edge id to graph edge for amount lookup
		const visEdgeToGraphEdge: {[id: number]: typeof outputEdges[0]} = {};
		for (const graphEdge of outputEdges) {
			visEdgeToGraphEdge[graphEdge.id] = graphEdge;
		}

		// Remove all edges connected to the original node
		for (const visEdge of allVisEdges) {
			edges.remove(visEdge.id);
		}
		// Remove the original node
		nodes.remove(nodeId);

		// Create one split node per output edge
		for (let i = 0; i < visOutputEdges.length; i++) {
			const outEdge = visOutputEdges[i];
			const splitNodeId = this.splitNodeIdCounter++;
			splitNodeIds.push(splitNodeId);

			// Position split nodes spread out from original position
			const offsetY = (i - (visOutputEdges.length - 1) / 2) * 120;

			// Calculate proportional machine amount based on output edge flow
			const graphEdge = visEdgeToGraphEdge[outEdge.id];
			const fraction = (graphEdge && totalOutputAmount > 0) ? graphEdge.itemAmount.amount / totalOutputAmount : 1 / visOutputEdges.length;
			const splitAmount = recipeNode.recipeData.amount * fraction;

// Create split node label with proportional machine count
const splitLabel = '<b>Split ' + recipeNode.recipeData.recipe.name + '</b>\n' + Strings.formatNumber(splitAmount) + 'x ' + recipeNode.recipeData.machine.name + '\n<i>' + recipeNode.recipeData.clockSpeed + '% clock speed</i>';

// Create hover tooltip matching RecipeNode.getTooltip() format exactly
const splitRecipeData = new RecipeData(recipeNode.recipeData.machine, recipeNode.recipeData.recipe, splitAmount, recipeNode.recipeData.clockSpeed);
const splitMachineGroup = new MachineGroup(splitRecipeData);
const splitMultiplier = splitAmount * recipeNode.recipeData.machine.metadata.manufacturingSpeed * (recipeNode.recipeData.clockSpeed / 100) * (60 / recipeNode.recipeData.recipe.time);

const titleLines: string[] = [];
for (const machine of splitMachineGroup.machines) {
titleLines.push(machine.amount + 'x ' + recipeNode.recipeData.machine.name + ' at <b>' + machine.clockSpeed + '%</b> clock speed');
}
titleLines.push('');
titleLines.push('Needed power: ' + Numbers.round(splitMachineGroup.power.average) + ' MW');
titleLines.push('');
for (const ingredient of recipeNode.recipeData.recipe.ingredients) {
const item = model.getItem(ingredient.item);
titleLines.push('<b>IN:</b> ' + Strings.formatItemAmount(ingredient.amount * splitMultiplier, ingredient.item) + ' - ' + item.prototype.name);
}
for (const product of recipeNode.recipeData.recipe.products) {
const item = model.getItem(product.item);
titleLines.push('<b>OUT:</b> ' + Strings.formatItemAmount(product.amount * splitMultiplier, product.item) + ' - ' + item.prototype.name);
}
const titleEl = document.createElement('div');
titleEl.innerHTML = titleLines.join('<br>');

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

// Create the output edge from split node to the target
			const splitOutEdgeId = this.splitEdgeIdCounter++;
			splitEdgeIds.push(splitOutEdgeId);
			edges.add({
				id: splitOutEdgeId,
				from: splitNodeId,
				to: outEdge.to,
				label: outEdge.label || '',
				color: outEdge.color || {
					color: 'rgba(105, 125, 145, 1)',
					highlight: 'rgba(134, 151, 167, 1)',
				},
				font: outEdge.font || {
					color: 'rgba(238, 238, 238, 1)',
				},
				smooth: outEdge.smooth,
			} as any);

			// Duplicate all input edges to this split node
			for (const inEdge of visInputEdges) {
				const splitInEdgeId = this.splitEdgeIdCounter++;
				splitEdgeIds.push(splitInEdgeId);
				edges.add({
					id: splitInEdgeId,
					from: inEdge.from,
					to: splitNodeId,
					label: inEdge.label || '',
					color: inEdge.color || {
						color: 'rgba(105, 125, 145, 1)',
						highlight: 'rgba(134, 151, 167, 1)',
					},
					font: inEdge.font || {
						color: 'rgba(238, 238, 238, 1)',
					},
					smooth: inEdge.smooth,
				} as any);
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

this.splitGroups.push(group);
this.saveSplitNodes();
this.saveNodePositions();
}

	private splitRecipeByInput(nodeId: number, recipeNode: RecipeNode, nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
	{
		// Only allow split if recipe has exactly 1 ingredient item type
		if (recipeNode.recipeData.recipe.ingredients.length !== 1) {
			return;
		}

		// Find input edges to this node in the graph
		const inputEdges = result.graph.edges.filter((e) => e.to.id === nodeId);
		// If 1 or fewer inputs, nothing to split
		if (inputEdges.length <= 1) {
			return;
		}

		// Check this node isn't already part of a split group
		if (this.splitGroups.some((g) => g.originalNodeId === nodeId)) {
			return;
		}

		// Gather all vis edges connected to this node
		const allVisEdges = this.getVisEdgesForNode(nodeId, edges);
		// Separate into input edges and output edges
		const visOutputEdges = allVisEdges.filter((e: any) => e.from === nodeId);
		const visInputEdges = allVisEdges.filter((e: any) => e.to === nodeId);

		// Save original node data
		const originalNodeData = nodes.get(nodeId);
		if (!originalNodeData) {
			return;
		}

		// Save all original edge data
		const originalEdgesData = allVisEdges.map((e: any) => ({...e}));

		// Get original node position
		const positions = this.network.getPositions([nodeId]);
		const originalPos = positions[nodeId] || {x: 0, y: 0};

		const recipeKey = getNodeKey(recipeNode);
		const descriptor: ISplitDescriptor = {
			recipeNodeKey: recipeKey,
			splitType: 'input',
		};

		const splitNodeIds: number[] = [];
		const splitEdgeIds: number[] = [];

		// Calculate total input amount across all input edges
		const totalInputAmount = inputEdges.reduce((sum, e) => sum + e.itemAmount.amount, 0);

		// Build a map from vis edge id to graph edge for amount lookup
		const visEdgeToGraphEdge: {[id: number]: typeof inputEdges[0]} = {};
		for (const graphEdge of inputEdges) {
			visEdgeToGraphEdge[graphEdge.id] = graphEdge;
		}

		// Remove all edges connected to the original node
		for (const visEdge of allVisEdges) {
			edges.remove(visEdge.id);
		}
		// Remove the original node
		nodes.remove(nodeId);

		// Create one split node per input edge
		for (let i = 0; i < visInputEdges.length; i++) {
			const inEdge = visInputEdges[i];
			const splitNodeId = this.splitNodeIdCounter++;
			splitNodeIds.push(splitNodeId);

			// Position split nodes spread out from original position
			const offsetY = (i - (visInputEdges.length - 1) / 2) * 120;

			// Calculate proportional machine amount based on input edge flow
			const graphEdge = visEdgeToGraphEdge[inEdge.id];
			const fraction = (graphEdge && totalInputAmount > 0) ? graphEdge.itemAmount.amount / totalInputAmount : 1 / visInputEdges.length;
			const splitAmount = recipeNode.recipeData.amount * fraction;

// Create split node label with proportional machine count
const splitLabel = '<b>Split ' + recipeNode.recipeData.recipe.name + '</b>\n' + Strings.formatNumber(splitAmount) + 'x ' + recipeNode.recipeData.machine.name + '\n<i>' + recipeNode.recipeData.clockSpeed + '% clock speed</i>';

// Create hover tooltip matching RecipeNode.getTooltip() format exactly
const splitRecipeData = new RecipeData(recipeNode.recipeData.machine, recipeNode.recipeData.recipe, splitAmount, recipeNode.recipeData.clockSpeed);
const splitMachineGroup = new MachineGroup(splitRecipeData);
const splitMultiplier = splitAmount * recipeNode.recipeData.machine.metadata.manufacturingSpeed * (recipeNode.recipeData.clockSpeed / 100) * (60 / recipeNode.recipeData.recipe.time);

const titleLines: string[] = [];
for (const machine of splitMachineGroup.machines) {
titleLines.push(machine.amount + 'x ' + recipeNode.recipeData.machine.name + ' at <b>' + machine.clockSpeed + '%</b> clock speed');
}
titleLines.push('');
titleLines.push('Needed power: ' + Numbers.round(splitMachineGroup.power.average) + ' MW');
titleLines.push('');
for (const ingredient of recipeNode.recipeData.recipe.ingredients) {
const item = model.getItem(ingredient.item);
titleLines.push('<b>IN:</b> ' + Strings.formatItemAmount(ingredient.amount * splitMultiplier, ingredient.item) + ' - ' + item.prototype.name);
}
for (const product of recipeNode.recipeData.recipe.products) {
const item = model.getItem(product.item);
titleLines.push('<b>OUT:</b> ' + Strings.formatItemAmount(product.amount * splitMultiplier, product.item) + ' - ' + item.prototype.name);
}
const titleEl = document.createElement('div');
titleEl.innerHTML = titleLines.join('<br>');

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

// Create the input edge from the source to this split node
			const splitInEdgeId = this.splitEdgeIdCounter++;
			splitEdgeIds.push(splitInEdgeId);
			edges.add({
				id: splitInEdgeId,
				from: inEdge.from,
				to: splitNodeId,
				label: inEdge.label || '',
				color: inEdge.color || {
					color: 'rgba(105, 125, 145, 1)',
					highlight: 'rgba(134, 151, 167, 1)',
				},
				font: inEdge.font || {
					color: 'rgba(238, 238, 238, 1)',
				},
				smooth: inEdge.smooth,
			} as any);

			// Duplicate all output edges from this split node
			for (const outEdge of visOutputEdges) {
				const splitOutEdgeId = this.splitEdgeIdCounter++;
				splitEdgeIds.push(splitOutEdgeId);
				edges.add({
					id: splitOutEdgeId,
					from: splitNodeId,
					to: outEdge.to,
					label: outEdge.label || '',
					color: outEdge.color || {
						color: 'rgba(105, 125, 145, 1)',
						highlight: 'rgba(134, 151, 167, 1)',
					},
					font: outEdge.font || {
						color: 'rgba(238, 238, 238, 1)',
					},
					smooth: outEdge.smooth,
				} as any);
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

this.splitGroups.push(group);
this.saveSplitNodes();
this.saveNodePositions();
}

private combineSplitGroup(groupIndex: number, nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>): void
{
const group = this.splitGroups[groupIndex];

// Remove all split edges
for (const edgeId of group.splitEdgeIds) {
edges.remove(edgeId);
}

// Remove all split nodes
for (const nodeId of group.splitNodeIds) {
nodes.remove(nodeId);
}

// Restore original node
nodes.add(group.originalNodeData);

// Restore original edges
for (const edgeData of group.originalEdgesData) {
edges.add(edgeData);
}

// Remove from tracking
this.splitGroups.splice(groupIndex, 1);

this.saveSplitNodes();
this.saveNodePositions();
}

private getVisEdgesForNode(nodeId: number, edges: DataSet<IVisEdge>): any[]
{
return edges.get().filter((e: any) => e.from === nodeId || e.to === nodeId);
}

private applyStoredSplits(nodes: DataSet<IVisNode>, edges: DataSet<IVisEdge>, result: ProductionResult): void
{
const descriptors = this.loadSplitNodes();
if (descriptors.length === 0) {
return;
}

const appliedDescriptors: ISplitDescriptor[] = [];

for (const descriptor of descriptors) {
// Find the matching recipe node by key
const graphNode = result.graph.nodes.find((n) => getNodeKey(n) === descriptor.recipeNodeKey);
if (!graphNode || !(graphNode instanceof RecipeNode)) {
continue;
}

// Check the node still exists in the vis DataSet (not already split)
const visNode = nodes.get(graphNode.id);
if (!visNode) {
continue;
}

// Apply the split
if (descriptor.splitType === 'output') {
if (graphNode.recipeData.recipe.products.length !== 1) {
continue;
}
const outputEdges = result.graph.edges.filter((e) => e.from.id === graphNode.id);
if (outputEdges.length <= 1) {
continue;
}
this.splitRecipeByOutput(graphNode.id, graphNode, nodes, edges, result);
} else {
if (graphNode.recipeData.recipe.ingredients.length !== 1) {
continue;
}
const inputEdges = result.graph.edges.filter((e) => e.to.id === graphNode.id);
if (inputEdges.length <= 1) {
continue;
}
this.splitRecipeByInput(graphNode.id, graphNode, nodes, edges, result);
}

// Restore saved positions for split nodes
const group = this.splitGroups[this.splitGroups.length - 1];
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

appliedDescriptors.push(descriptor);
}

// If some descriptors weren't applied (stale), save only the valid ones
if (appliedDescriptors.length !== descriptors.length) {
this.saveSplitNodesFromDescriptors(appliedDescriptors);
}
}

// ==================== Split Node Persistence ====================

private saveSplitNodes(): void
{
// Capture current split node positions into descriptors before saving
if (this.network) {
for (const group of this.splitGroups) {
const allSplitNodeIds = group.splitNodeIds;
const pos = this.network.getPositions(allSplitNodeIds);
const posMap: {[index: string]: {x: number, y: number}} = {};
for (let i = 0; i < allSplitNodeIds.length; i++) {
if (pos[allSplitNodeIds[i]]) {
posMap[i.toString()] = pos[allSplitNodeIds[i]];
}
}
group.descriptor.splitNodePositions = posMap;
}
}
const descriptors = this.splitGroups.map((g) => g.descriptor);
this.saveSplitNodesFromDescriptors(descriptors);
}

private saveSplitNodesFromDescriptors(descriptors: ISplitDescriptor[]): void
{
try {
let allSplits: {[key: string]: ISplitDescriptor[]} = {};
const existing = localStorage.getItem(CustomGraphComponentController.SPLIT_NODES_STORAGE_KEY);
if (existing) {
allSplits = JSON.parse(existing);
}
allSplits[this.tabId] = descriptors;
localStorage.setItem(CustomGraphComponentController.SPLIT_NODES_STORAGE_KEY, JSON.stringify(allSplits));
} catch (e) {
// ignore
}
}

private loadSplitNodes(): ISplitDescriptor[]
{
try {
const stored = localStorage.getItem(CustomGraphComponentController.SPLIT_NODES_STORAGE_KEY);
if (stored) {
const allSplits = JSON.parse(stored);
if (allSplits[this.tabId]) {
return allSplits[this.tabId];
}
}
} catch (e) {
// ignore
}
return [];
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
// Get all positions and filter out link node IDs (>=100000) and split node IDs (>=300000) to keep storage clean
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
			multiselect: true,
		},
});
}

}