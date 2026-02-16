import {GraphNode} from '@src/Tools/Production/Result/Nodes/GraphNode';
import {GraphEdge} from '@src/Tools/Production/Result/Edges/GraphEdge';
import {ItemAmount} from '@src/Tools/Production/Result/ItemAmount';
import {IntermediateNode} from '@src/Tools/Production/Result/Nodes/IntermediateNode';
import {RecipeNode} from '@src/Tools/Production/Result/Nodes/RecipeNode';
import {GeneratorNode} from '@src/Tools/Production/Result/Nodes/GeneratorNode';
import {IJsonSchema} from '@src/Schema/IJsonSchema';
import {Constants} from '@src/Constants';

export class Graph
{

public readonly DELTA = 1e-8;

public nodes: GraphNode[] = [];
public edges: GraphEdge[] = [];

private lastId = 1;

public addNode(node: GraphNode): void
{
this.nodes.push(node);
node.id = this.lastId++;
}

public addEdge(edge: GraphEdge): void
{
this.edges.push(edge);
edge.id = this.lastId++;
}

public removeEdge(edge: GraphEdge): void
{
const edgeIndex = this.edges.indexOf(edge);
if (edgeIndex !== -1) {
this.edges.splice(edgeIndex, 1);
}
const fromIndex = edge.from.connectedEdges.indexOf(edge);
if (fromIndex !== -1) {
edge.from.connectedEdges.splice(fromIndex, 1);
}
const toIndex = edge.to.connectedEdges.indexOf(edge);
if (toIndex !== -1) {
edge.to.connectedEdges.splice(toIndex, 1);
}
}

public generateEdges(): void
{
for (const nodeOut of this.nodes) {
outputLoop:
for (const output of nodeOut.getOutputs()) {

for (const nodeIn of this.nodes) {
for (const input of nodeIn.getInputs()) {
if (input.resource === output.resource && input.amount < input.maxAmount) {
const diff = Math.min(input.maxAmount - input.amount, output.amount);

output.amount -= diff;
input.amount += diff;
if (Math.abs(input.maxAmount - input.amount) < this.DELTA) {
input.amount = input.maxAmount;
}
if (Math.abs(output.amount) < this.DELTA) {
output.amount = 0;
}

this.addEdge(new GraphEdge(nodeOut, nodeIn, new ItemAmount(output.resource.className, diff)));

if (output.amount === 0) {
continue outputLoop;
}
}
}
}
}
}
}

public insertIntermediateNodes(intermediateItems: string[], data: IJsonSchema): void
{
const waterClassName = Constants.WATER_CLASSNAME;

for (const itemClassName of intermediateItems) {
if (itemClassName === waterClassName) {
this.insertWaterIntermediateNodes(itemClassName, data);
} else {
this.insertSingleIntermediateNode(itemClassName, data);
}
}
}

private insertSingleIntermediateNode(itemClassName: string, data: IJsonSchema): void
{
const itemSchema = data.items[itemClassName];
if (!itemSchema) {
return;
}

const matchingEdges = this.edges.filter((edge) => edge.itemAmount.item === itemClassName);
if (matchingEdges.length === 0) {
return;
}

const intermediateNode = new IntermediateNode(itemSchema);
this.addNode(intermediateNode);

// Accumulate amounts per source and per target to merge duplicate edges
const sourceAmounts: {[key: number]: {node: GraphNode, amount: number}} = {};
const targetAmounts: {[key: number]: {node: GraphNode, amount: number}} = {};
let totalFlow = 0;

for (const edge of matchingEdges) {
totalFlow += edge.itemAmount.amount;

if (!(edge.from.id in sourceAmounts)) {
sourceAmounts[edge.from.id] = {node: edge.from, amount: 0};
}
sourceAmounts[edge.from.id].amount += edge.itemAmount.amount;

if (!(edge.to.id in targetAmounts)) {
targetAmounts[edge.to.id] = {node: edge.to, amount: 0};
}
targetAmounts[edge.to.id].amount += edge.itemAmount.amount;
}
intermediateNode.totalAmount = totalFlow;

// Take a snapshot of matching edges before modifying
const edgesToProcess = [...matchingEdges];

// Remove all matching edges
for (const edge of edgesToProcess) {
this.removeEdge(edge);
}

// Create one consolidated edge per unique source -> intermediate
for (const id in sourceAmounts) {
const entry = sourceAmounts[id];
this.addEdge(new GraphEdge(entry.node, intermediateNode, new ItemAmount(itemClassName, entry.amount)));
}

// Create one consolidated edge per intermediate -> unique target
for (const id in targetAmounts) {
const entry = targetAmounts[id];
this.addEdge(new GraphEdge(intermediateNode, entry.node, new ItemAmount(itemClassName, entry.amount)));
}
}

private insertWaterIntermediateNodes(itemClassName: string, data: IJsonSchema): void
{
const itemSchema = data.items[itemClassName];
if (!itemSchema) {
return;
}

const matchingEdges = this.edges.filter((edge) => edge.itemAmount.item === itemClassName);
if (matchingEdges.length === 0) {
return;
}

// Create per-recipe intermediate nodes for sources (recipes that output water)
const sourceIntermediates = new Map<GraphNode, IntermediateNode>();
const sourceAmounts = new Map<GraphNode, number>();

// Create per-recipe intermediate nodes for targets (recipes that input water)
const targetIntermediates = new Map<GraphNode, IntermediateNode>();
const targetAmounts = new Map<GraphNode, number>();

for (const edge of matchingEdges) {
// Source intermediate for recipe/generator nodes that output water
if (edge.from instanceof RecipeNode || edge.from instanceof GeneratorNode) {
if (!sourceIntermediates.has(edge.from)) {
const name = edge.from instanceof RecipeNode ? edge.from.recipeData.recipe.name : 'Generator';
const node = new IntermediateNode(itemSchema, name);
this.addNode(node);
sourceIntermediates.set(edge.from, node);
sourceAmounts.set(edge.from, 0);
}
sourceAmounts.set(edge.from, sourceAmounts.get(edge.from)! + edge.itemAmount.amount);
}

// Target intermediate for recipe/generator nodes that input water
if (edge.to instanceof RecipeNode || edge.to instanceof GeneratorNode) {
if (!targetIntermediates.has(edge.to)) {
const name = edge.to instanceof RecipeNode ? edge.to.recipeData.recipe.name : 'Generator';
const node = new IntermediateNode(itemSchema, name);
this.addNode(node);
targetIntermediates.set(edge.to, node);
targetAmounts.set(edge.to, 0);
}
targetAmounts.set(edge.to, targetAmounts.get(edge.to)! + edge.itemAmount.amount);
}
}

// Set total amounts on intermediate nodes
sourceAmounts.forEach((amount, source) => {
sourceIntermediates.get(source)!.totalAmount = amount;
});
targetAmounts.forEach((amount, target) => {
targetIntermediates.get(target)!.totalAmount = amount;
});

// Take a snapshot of matching edges before modifying
const edgesToProcess = [...matchingEdges];

// Remove all water edges that involve at least one recipe/generator node
for (const edge of edgesToProcess) {
if (sourceIntermediates.has(edge.from) || targetIntermediates.has(edge.to)) {
this.removeEdge(edge);
}
}

// Create one edge per source recipe -> its intermediate (terminal, no outgoing edges)
sourceAmounts.forEach((amount, source) => {
const interm = sourceIntermediates.get(source)!;
this.addEdge(new GraphEdge(source, interm, new ItemAmount(itemClassName, amount)));
});

// Create one edge per target intermediate -> its recipe (terminal, no incoming edges)
targetAmounts.forEach((amount, target) => {
const interm = targetIntermediates.get(target)!;
this.addEdge(new GraphEdge(interm, target, new ItemAmount(itemClassName, amount)));
});
}

}