import {GraphNode} from '@src/Tools/Production/Result/Nodes/GraphNode';
import {IVisNode} from '@src/Tools/Production/Result/IVisNode';
import {ResourceAmount} from '@src/Tools/Production/Result/ResourceAmount';
import {IItemSchema} from '@src/Schema/IItemSchema';
import {Strings} from '@src/Utils/Strings';

export class LinkNode extends GraphNode
{

	public readonly resource: IItemSchema;
	public totalAmount: number = 0;
	public readonly direction: 'in' | 'out';

	public constructor(resource: IItemSchema, direction: 'in' | 'out', public readonly recipeName?: string)
	{
		super();
		this.resource = resource;
		this.direction = direction;
	}

	public getInputs(): ResourceAmount[]
	{
		return [];
	}

	public getOutputs(): ResourceAmount[]
	{
		return [];
	}

	public getTitle(): string
	{
		const dirLabel = this.direction === 'out' ? 'Link Out' : 'Link In';
		const preposition = this.direction === 'out' ? 'From' : 'To';
		let title = '<b>' + dirLabel + ': ' + this.resource.name + '</b>';
		if (this.recipeName) {
			title += '\n<i>' + preposition + ': ' + this.recipeName + '</i>';
		}
		title += '\n' + Strings.formatItemAmount(this.totalAmount, this.resource.className);
		return title;
	}

	public getTooltip(): string|null
	{
		return null;
	}

	public getVisNode(): IVisNode
	{
		return {
			id: this.id,
			label: this.getTitle(),
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
		};
	}

}