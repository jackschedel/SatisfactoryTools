import {GraphNode} from '@src/Tools/Production/Result/Nodes/GraphNode';
import {IVisNode} from '@src/Tools/Production/Result/IVisNode';
import {ResourceAmount} from '@src/Tools/Production/Result/ResourceAmount';
import {IItemSchema} from '@src/Schema/IItemSchema';
import {Strings} from '@src/Utils/Strings';

export class IntermediateNode extends GraphNode
{

	public readonly resource: IItemSchema;
	public totalAmount: number = 0;

	public constructor(resource: IItemSchema, public readonly label?: string)
	{
		super();
		this.resource = resource;
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
		let title = this.formatText(this.resource.name);
		if (this.label) {
			title += '\n<i>' + this.label + '</i>';
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
				background: 'rgba(100, 100, 180, 1)',
				highlight: {
					border: 'rgba(238, 238, 238, 1)',
					background: 'rgba(130, 130, 200, 1)',
				},
			},
			font: {
				color: 'rgba(238, 238, 238, 1)',
			},
		};
	}

}