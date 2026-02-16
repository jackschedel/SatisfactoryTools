import {IController, IScope, ITimeoutService} from 'angular';
import {DataSet, Network} from 'vis-network';
import ELK from 'elkjs/lib/elk.bundled';
import {IVisNode} from '@src/Tools/Production/Result/IVisNode';
import {IVisEdge} from '@src/Tools/Production/Result/IVisEdge';
import {IElkGraph} from '@src/Solver/IElkGraph';

export class ViewerController implements IController
{

	public graphJson: string = '';
	public graphData: any = null;
	public errorMessage: string = '';

	public static $inject = ['$scope', '$element', '$timeout'];
	public constructor(private readonly $scope: IScope, private readonly $element: any, private readonly $timeout: ITimeoutService)
	{
	}

	public loadGraph(): void
	{
		this.errorMessage = '';
		this.graphData = null;

		if (!this.graphJson || !this.graphJson.trim()) {
			this.errorMessage = 'Please paste a graph JSON object.';
			return;
		}

		try {
			const parsed = JSON.parse(this.graphJson);
			if (!parsed.nodes || !parsed.edges) {
				this.errorMessage = 'Invalid graph JSON: missing "nodes" or "edges" properties.';
				return;
			}
			this.graphData = parsed;
			this.$timeout(() => {
				this.renderGraph(parsed);
			});
		} catch (e) {
			this.errorMessage = 'Invalid JSON: ' + (e as Error).message;
		}
	}

	public clearGraph(): void
	{
		this.graphJson = '';
		this.graphData = null;
		this.errorMessage = '';
		const container = this.$element[0].querySelector('.viewer-graph-container');
		if (container) {
			container.innerHTML = '';
		}
	}

	private renderGraph(data: any): void
	{
		const container = this.$element[0].querySelector('.viewer-graph-container');
		if (!container) {
			return;
		}

		container.innerHTML = '';

		const nodes = new DataSet<IVisNode>();
		const edges = new DataSet<IVisEdge>();

		for (const node of data.nodes) {
			nodes.add({
				id: node.id,
				label: node.label || '',
				x: node.x,
				y: node.y,
				color: node.color,
				font: node.font,
			} as any);
		}

		for (const edge of data.edges) {
			edges.add({
				id: edge.id,
				from: edge.from,
				to: edge.to,
				label: edge.label || '',
				color: edge.color,
				font: edge.font,
				smooth: edge.smooth,
			} as any);
		}

		const network = new Network(container, {
			nodes: nodes,
			edges: edges,
		}, {
			height: '600px',
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

		// If no positions provided, run ELK layout
		const hasPositions = data.nodes.some((n: any) => n.x !== undefined && n.y !== undefined);
		if (hasPositions) {
			network.fit();
		} else {
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

				const elk = new ELK();
				elk.layout(elkGraph).then((layoutData) => {
					nodes.forEach((node) => {
						const id = node.id;
						if (layoutData.children) {
							for (const item of layoutData.children) {
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
					network.fit();
				});
			});
		}
	}

}