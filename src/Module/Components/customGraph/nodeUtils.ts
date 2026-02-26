import { GraphNode } from '@src/Tools/Production/Result/Nodes/GraphNode';
import { RecipeNode } from '@src/Tools/Production/Result/Nodes/RecipeNode';
import { InputNode } from '@src/Tools/Production/Result/Nodes/InputNode';
import { MinerNode } from '@src/Tools/Production/Result/Nodes/MinerNode';
import { ProductNode } from '@src/Tools/Production/Result/Nodes/ProductNode';
import { ByproductNode } from '@src/Tools/Production/Result/Nodes/ByproductNode';
import { SinkNode } from '@src/Tools/Production/Result/Nodes/SinkNode';
import { GeneratorNode } from '@src/Tools/Production/Result/Nodes/GeneratorNode';
import { IntermediateNode } from '@src/Tools/Production/Result/Nodes/IntermediateNode';

export function getNodeKey(node: GraphNode): string {
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

export function getNodeDisplayName(node: GraphNode): string {
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
