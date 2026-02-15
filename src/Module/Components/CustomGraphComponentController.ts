import {DataSet, Network} from 'vis-network';
import {IController, IIntervalService, IPromise, IScope, ITimeoutService} from 'angular';
import ELK from 'elkjs/lib/elk.bundled';
import {IVisNode} from '@src/Tools/Production/Result/IVisNode';
import {IVisEdge} from '@src/Tools/Production/Result/IVisEdge';
import {IElkGraph} from '@src/Solver/IElkGraph';
import {Strings} from '@src/Utils/Strings';
import model from '@src/Data/Model';
import {ProductionResult} from '@src/Tools/Production/Result/ProductionResult';

export class CustomGraphComponentController implements IController
{

public result: ProductionResult;
public tabId: string;
public frozen: boolean = false;

public static $inject = ['$element', '$scope', '$timeout', '$interval'];

private unregisterWatcherCallback: () => void;
private unregisterTabIdWatcherCallback: () => void;
private network: Network;
private fitted: boolean = false;
private interval: IPromise<any>;
private frozenResult: ProductionResult|undefined;
private graphContainer: HTMLElement;

private static readonly POSITIONS_STORAGE_KEY = 'customGraphNodePositions';
private static readonly FROZEN_STORAGE_KEY = 'customGraphFrozenTabs';

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

public toggleFreeze(): void
{
this.frozen = !this.frozen;
this.saveFrozenState();

if (!this.frozen) {
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
const nodes = new DataSet<IVisNode>();
const edges = new DataSet<IVisEdge>();

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

// Save positions after layout
this.$timeout(100).then(() => {
this.saveNodePositions();
});
});
});
});
}

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
allPositions[tabId] = this.network.getPositions();
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