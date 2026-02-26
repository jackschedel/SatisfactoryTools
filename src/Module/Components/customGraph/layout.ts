import ELK from 'elkjs/lib/elk.bundled';
import { DataSet } from 'vis-network';
import { IVisNode } from '@src/Tools/Production/Result/IVisNode';
import { IVisEdge } from '@src/Tools/Production/Result/IVisEdge';
import { IElkGraph } from '@src/Solver/IElkGraph';

export function performElkLayout(
	nodes: DataSet<IVisNode>,
	edges: DataSet<IVisEdge>,
): Promise<void> {
	const elkGraph: IElkGraph = {
		id: 'root',
		layoutOptions: {
			'elk.algorithm': 'org.eclipse.elk.layered',
			'org.eclipse.elk.layered.nodePlacement.favorStraightEdges':
				true as unknown as string,
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
	return elk.layout(elkGraph).then((data) => {
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
	});
}
