import { DataSet, Network } from 'vis-network';
import {
	IController,
	IIntervalService,
	IPromise,
	IScope,
	ITimeoutService,
} from 'angular';
import ELK from 'elkjs/lib/elk.bundled';
import { IVisNode } from '@src/Tools/Production/Result/IVisNode';
import { IVisEdge } from '@src/Tools/Production/Result/IVisEdge';
import { IElkGraph } from '@src/Solver/IElkGraph';
import { Strings } from '@src/Utils/Strings';
import model from '@src/Data/Model';
import { ProductionResult } from '@src/Tools/Production/Result/ProductionResult';
import { RecipeNode } from '@src/Tools/Production/Result/Nodes/RecipeNode';
import { InputNode } from '@src/Tools/Production/Result/Nodes/InputNode';
import { MinerNode } from '@src/Tools/Production/Result/Nodes/MinerNode';
import { ProductNode } from '@src/Tools/Production/Result/Nodes/ProductNode';
import { IntermediateNode } from '@src/Tools/Production/Result/Nodes/IntermediateNode';
import { ILinkNodeDescriptor } from '@src/Tools/Production/IProductionData';
import {
	ILinkPair,
	ISplitDescriptor,
	ISplitGroup,
	ICombinedLinkDescriptor,
	ICombinedLinkGroup,
	IGraphTabState,
	ICustomGraphState,
} from './customGraph/types';
import { getNodeKey, getNodeDisplayName } from './customGraph/nodeUtils';
import {
	saveGraphStateForTab as saveGraphStateForTabFn,
	loadGraphState as loadGraphStateFn,
	hasSavedPositionsForGraph as hasSavedPositionsForGraphFn,
} from './customGraph/persistence';
import * as LinkOps from './customGraph/linkOperations';
import * as CombinedOps from './customGraph/combinedLinkOperations';
import * as SplitOps from './customGraph/splitOperations';

export class CustomGraphComponentController implements IController, ICustomGraphState {
	public result: ProductionResult;
	public tabId: string;
	public intermediateItems: string[];
	public frozen: boolean = false;
	public exportMessage: string = '';
	public network: Network;
	public linkPairs: ILinkPair[] = [];
	public currentResult: ProductionResult | null = null;
	public splitGroups: ISplitGroup[] = [];
	public combinedLinkGroups: ICombinedLinkGroup[] = [];
	public contextMenu: {
		visible: boolean;
		x: number;
		y: number;
		items: { label: string; icon: string; action: () => void }[];
	} = { visible: false, x: 0, y: 0, items: [] };
	public nodeIdToKeyMap: { [id: number]: string } = {};

	public static $inject = ['$element', '$scope', '$timeout', '$interval'];

	private unregisterWatcherCallback: () => void;
	private unregisterTabIdWatcherCallback: () => void;
	private unregisterIntermediateWatcherCallback: () => void;
	private fitted: boolean = false;
	private interval: IPromise<any>;
	private frozenResult: ProductionResult | undefined;
	private graphContainer: HTMLElement;
	private linkNodeIdCounter: number = 100000;
	private linkEdgeIdCounter: number = 200000;
	private nodesDataSet: DataSet<IVisNode> | null = null;
	private edgesDataSet: DataSet<IVisEdge> | null = null;
	private splitNodeIdCounter: number = 300000;
	private splitEdgeIdCounter: number = 400000;
	private combinedNodeIdCounter: number = 500000;
	private combinedEdgeIdCounter: number = 600000;
	private multiSelectedNodes: number[] = [];
	private preservedPositionsMap: {
		[key: string]: { x: number; y: number };
	} | null = null;
	private _suppressSave: boolean = false;

	public constructor(
		private readonly $element: any,
		private readonly $scope: IScope,
		private readonly $timeout: ITimeoutService,
		private readonly $interval: IIntervalService,
	) {}

	public nextLinkNodeId(): number { return this.linkNodeIdCounter++; }
	public nextLinkEdgeId(): number { return this.linkEdgeIdCounter++; }
	public nextSplitNodeId(): number { return this.splitNodeIdCounter++; }
	public nextSplitEdgeId(): number { return this.splitEdgeIdCounter++; }
	public nextCombinedNodeId(): number { return this.combinedNodeIdCounter++; }
	public nextCombinedEdgeId(): number { return this.combinedEdgeIdCounter++; }

	public saveGraphState(): void { saveGraphStateForTabFn(this, this.tabId, this.frozen, this._suppressSave); }

	public $onInit(): void {
		this.frozen = this.loadGraphState().frozen;
		let initialRenderDone = false;

		// Watch for tab changes — reload frozen state for the new tab
		this.unregisterTabIdWatcherCallback = this.$scope.$watch(
			() => {
				return this.tabId;
			},
			(newTabId, oldTabId) => {
				if (newTabId !== oldTabId) {
					// Save state for the old tab before switching
					this.saveGraphStateForTab(oldTabId);
					// Reload frozen state for the new tab
					this.frozen = this.loadGraphState().frozen;
					// Need to re-render for the new tab
					initialRenderDone = false;
				}
			},
		);

		// Watch for intermediate items changes — update even when frozen
		// Use $timeout to defer so ProductionTab.rebuildVisualization() has time
		// to set the new resultNew (which includes intermediate nodes) first.
		this.unregisterIntermediateWatcherCallback = this.$scope.$watchCollection(
			() => {
				return this.intermediateItems;
			},
			(newValue, oldValue) => {
				if (newValue === oldValue) {
					return;
				}
				this.$timeout(0).then(() => {
					if (this.result) {
						// Capture current node positions before rebuilding so existing nodes don't move
						if (this.frozen && this.network && this.nodesDataSet) {
							const rawPositions = this.network.getPositions();
							const posMap: { [key: string]: { x: number; y: number } } = {};
							this.nodesDataSet.forEach((node: any) => {
								const id = node.id;
								const key = this.nodeIdToKeyMap[id];
								if (key && rawPositions[id]) {
									posMap[key] = rawPositions[id];
								}
							});
							// Also capture link node positions by their descriptor keys
							for (const pair of this.linkPairs) {
								if (rawPositions[pair.linkOutId]) {
									const outKey =
										'linkOut:' +
										pair.descriptor.fromNodeKey +
										'||' +
										pair.descriptor.toNodeKey +
										'||' +
										pair.descriptor.itemClassName;
									posMap[outKey] = rawPositions[pair.linkOutId];
								}
								if (rawPositions[pair.linkInId]) {
									const inKey =
										'linkIn:' +
										pair.descriptor.fromNodeKey +
										'||' +
										pair.descriptor.toNodeKey +
										'||' +
										pair.descriptor.itemClassName;
									posMap[inKey] = rawPositions[pair.linkInId];
								}
							}
							// Also capture split node positions
							for (const group of this.splitGroups) {
								for (let i = 0; i < group.splitNodeIds.length; i++) {
									const splitId = group.splitNodeIds[i];
									if (rawPositions[splitId]) {
										const splitKey =
											'split:' +
											group.descriptor.recipeNodeKey +
											'||' +
											i;
										posMap[splitKey] = rawPositions[splitId];
									}
								}
							}
							// Also capture combined link node positions
							for (const group of this.combinedLinkGroups) {
								if (rawPositions[group.combinedOutId]) {
									const outKey =
										'combinedOut:' +
										group.descriptor.type +
										'||' +
										group.descriptor.itemClassName +
										'||' +
										group.descriptor.sourceKey;
									posMap[outKey] = rawPositions[group.combinedOutId];
								}
								if (rawPositions[group.combinedInId]) {
									const inKey =
										'combinedIn:' +
										group.descriptor.type +
										'||' +
										group.descriptor.itemClassName +
										'||' +
										group.descriptor.sourceKey;
									posMap[inKey] = rawPositions[group.combinedInId];
								}
							}
							this.preservedPositionsMap = posMap;
						}
						this.frozenResult = this.result;
						this.updateData(this.result);
					}
				});
			},
		);

		this.unregisterWatcherCallback = this.$scope.$watch(
			() => {
				return this.result;
			},
			(newValue) => {
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
			},
		);

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

	public $onDestroy(): void {
		this.saveGraphState();
		this.unregisterWatcherCallback();
		this.unregisterTabIdWatcherCallback();
		this.unregisterIntermediateWatcherCallback();
		this.$interval.cancel(this.interval);
	}

	public autoArrange(): void {
		if (!this.network || !this.nodesDataSet || !this.edgesDataSet) {
			return;
		}

		const nodes = this.nodesDataSet;
		const edges = this.edgesDataSet;

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
			this.saveGraphState();
		});
	}

	public exportGraph(): void {
		if (!this.network || !this.nodesDataSet || !this.edgesDataSet) {
			return;
		}

		const positions = this.network.getPositions();
		const nodesExport: any[] = [];
		this.nodesDataSet.forEach((node: any) => {
			const pos = positions[node.id] || { x: 0, y: 0 };
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

	public toggleFreeze(): void {
		this.frozen = !this.frozen;

		if (!this.frozen) {
			// Clear link nodes when unfreezing
			this.linkPairs = [];
			// Clear split nodes when unfreezing
			this.splitGroups = [];
			// Clear combined links when unfreezing
			this.combinedLinkGroups = [];
			this.saveGraphState();
			this.frozenResult = this.result;
			this.updateData(this.result);
		} else {
			this.saveGraphState();
		}
	}

	public updateData(result: ProductionResult | undefined): void {
		if (!result) {
			return;
		}

		this.fitted = false;
		this.useVis(result);
	}

	public useVis(result: ProductionResult): void {
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

		// Build stable key map for position persistence
		this.nodeIdToKeyMap = {};
		for (const node of result.graph.nodes) {
			this.nodeIdToKeyMap[node.id] = getNodeKey(node);
		}

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
				label:
					model.getItem(edge.itemAmount.item).prototype.name +
					'\n' +
					Strings.formatItemAmount(
						edge.itemAmount.amount,
						edge.itemAmount.item,
					),
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
			this.saveGraphState();
		});

		// Always run ELK layout first (exactly like Visualization)
		this.$timeout(0).then(() => {
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

					// Load the entire graph state once for this tab
					const graphState = this.loadGraphState();

					// After ELK layout, check if we have preserved positions from an intermediate node change
					const preservedMap = this.preservedPositionsMap;
					this.preservedPositionsMap = null;
					const savedPositions = graphState.nodePositions;

					if (preservedMap && this.frozen) {
						// Restore all nodes that existed before to their original positions
						const newNodeKeys: string[] = [];
						nodes.forEach((node) => {
							const id = node.id;
							const key = this.nodeIdToKeyMap[id];
							if (key && preservedMap[key]) {
								nodes.update({
									id: id,
									x: preservedMap[key].x,
									y: preservedMap[key].y,
								});
							} else if (key) {
								newNodeKeys.push(key);
							}
						});

						// Place new nodes at non-overlapping positions
						if (newNodeKeys.length > 0) {
							const occupiedPositions: { x: number; y: number }[] = [];
							nodes.forEach((node: any) => {
								const key = this.nodeIdToKeyMap[node.id];
								if (key && preservedMap[key]) {
									occupiedPositions.push({
										x: preservedMap[key].x,
										y: preservedMap[key].y,
									});
								}
							});

							for (const newKey of newNodeKeys) {
								const nodeId = Object.keys(this.nodeIdToKeyMap).find(
									(id) => this.nodeIdToKeyMap[parseInt(id, 10)] === newKey,
								);
								if (!nodeId) continue;

								// Find ALL connected neighbors and compute their centroid
								const numId = parseInt(nodeId, 10);
								const connectedEdges = edges
									.get()
									.filter((e: any) => e.from === numId || e.to === numId);
								let sumX = 0;
								let sumY = 0;
								let neighborCount = 0;
								for (const ce of connectedEdges) {
									const otherId = (
										ce.from === numId ? ce.to : ce.from
									) as number;
									const otherKey = this.nodeIdToKeyMap[otherId];
									if (otherKey && preservedMap[otherKey]) {
										sumX += preservedMap[otherKey].x;
										sumY += preservedMap[otherKey].y;
										neighborCount++;
									}
								}

								// Place at centroid of all neighbors (minimizes total edge length)
								let finalX = neighborCount > 0 ? sumX / neighborCount : 0;
								let finalY = neighborCount > 0 ? sumY / neighborCount : 0;

								// Nudge to avoid overlapping existing nodes
								const nodeWidth = 250;
								const nodeHeight = 100;
								const padding = 20;
								const attempts = 0;
								const isOverlapping = () =>
									occupiedPositions.some(
										(p) =>
											Math.abs(p.x - finalX) < nodeWidth + padding &&
											Math.abs(p.y - finalY) < nodeHeight + padding,
									);

								// Try spiral outward from centroid to find clear spot
								if (isOverlapping()) {
									const step = nodeHeight + padding;
									let found = false;
									for (let ring = 1; ring <= 10 && !found; ring++) {
										// Try positions in a ring around the centroid
										const offsets = [
											{ dx: 0, dy: -ring * step },
											{ dx: 0, dy: ring * step },
											{ dx: -ring * (nodeWidth + padding), dy: 0 },
											{ dx: ring * (nodeWidth + padding), dy: 0 },
											{ dx: -ring * (nodeWidth + padding), dy: -ring * step },
											{ dx: ring * (nodeWidth + padding), dy: -ring * step },
											{ dx: -ring * (nodeWidth + padding), dy: ring * step },
											{ dx: ring * (nodeWidth + padding), dy: ring * step },
										];
										for (const off of offsets) {
											const testX =
												(neighborCount > 0 ? sumX / neighborCount : 0) + off.dx;
											const testY =
												(neighborCount > 0 ? sumY / neighborCount : 0) + off.dy;
											const testOverlaps = occupiedPositions.some(
												(p) =>
													Math.abs(p.x - testX) < nodeWidth + padding &&
													Math.abs(p.y - testY) < nodeHeight + padding,
											);
											if (!testOverlaps) {
												finalX = testX;
												finalY = testY;
												found = true;
												break;
											}
										}
									}
								}

								nodes.update({ id: numId, x: finalX, y: finalY });
								occupiedPositions.push({ x: finalX, y: finalY });
							}
						}

						this.network.fit();
					} else {
						// Normal flow: restore saved positions if frozen and we have some matching positions
						if (
							this.frozen &&
							this.hasSavedPositionsForGraph(savedPositions, result)
						) {
							nodes.forEach((node) => {
								const id = node.id;
								const key = this.nodeIdToKeyMap[id];
								if (key && savedPositions[key]) {
									nodes.update({
										id: id,
										x: savedPositions[key].x,
										y: savedPositions[key].y,
									});
								}
							});
							this.network.fit();
						}
					}

					// Suppress saves during initial apply to prevent partial state overwrites
					this._suppressSave = true;

					// Apply stored split nodes after layout/positions are set (before links, since links can be on split edges)
					this.applyStoredSplits(
						nodes,
						edges,
						result,
						graphState.splitNodeDescriptors,
					);

					// Apply stored link nodes after layout/positions are set
					this.applyStoredLinks(
						nodes,
						edges,
						result,
						graphState.linkNodeDescriptors,
					);

					// Apply stored combined links after layout/positions are set
					this.applyStoredCombinedLinks(
						nodes,
						edges,
						result,
						graphState.combinedLinkDescriptors,
					);

					this._suppressSave = false;

					// Make Shift+click behave like Ctrl+click for vis-network's native
					// multi-select. vis-network (via Hammer.js) checks event.ctrlKey to
					// decide whether to add to selection. By overriding ctrlKey on the
					// DOM event in the capture phase (before Hammer.js sees it), Shift
					// becomes equivalent to Ctrl for selection purposes.
					const graphCanvas = this.getGraphContainer().querySelector('canvas');
					if (graphCanvas) {
						const patchShiftAsCtrl = (e: PointerEvent) => {
							if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
								Object.defineProperty(e, 'ctrlKey', { get: () => true });
							}
						};
						graphCanvas.addEventListener('pointerdown', patchShiftAsCtrl, true);
						graphCanvas.addEventListener('pointerup', patchShiftAsCtrl, true);
					}

					// Register click handler for syncing multiSelectedNodes and context menu dismissal
					this.network.on('click', (params: any) => {
						// Dismiss context menu on any click
						if (this.contextMenu.visible) {
							this.hideContextMenu();
							this.$scope.$applyAsync();
						}

						const srcEvent = params.event && params.event.srcEvent;
						const isMultiKey =
							srcEvent &&
							(srcEvent.shiftKey || srcEvent.ctrlKey || srcEvent.metaKey);

						if (isMultiKey) {
							// Ctrl/Cmd/Shift+click: vis-network handles multi-select natively
							// (Shift is patched to look like Ctrl above). Sync our tracking.
							this.multiSelectedNodes = (
								this.network.getSelectedNodes() as number[]
							).slice();
						} else {
							// Normal click (no modifier key)
							if (params.nodes.length === 1) {
								this.multiSelectedNodes = [params.nodes[0] as number];
							} else {
								this.multiSelectedNodes = [];
							}
						}
					});

					// Register right-click handler for context menu
					this.network.on('oncontext', (params: any) => {
						params.event.preventDefault();
						this.showContextMenu(params, nodes, edges, result);
					});

					// Save complete state after layout
					this.$timeout(100).then(() => {
						this.saveGraphState();
					});
				});
			});
		});
	}

	// ==================== Context Menu Methods ====================

	private showContextMenu(
		params: any,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
		// Dismiss any existing context menu first
		if (this.contextMenu.visible) {
			this.hideContextMenu();
		}

		const items: { label: string; icon: string; action: () => void }[] = [];

		// Determine what was right-clicked
		const clickPos =
			params.pointer && params.pointer.DOM
				? params.pointer.DOM
				: { x: 0, y: 0 };
		const nodeAtClick = this.network.getNodeAt(params.pointer.DOM) as
			| number
			| undefined;
		const edgeAtClick = this.network.getEdgeAt(params.pointer.DOM) as
			| number
			| undefined;

		// Check if we have multi-selected nodes (for combine links)
		let selectedNodeIds = this.network.getSelectedNodes() as number[];
		if (selectedNodeIds.length < 2 && this.multiSelectedNodes.length >= 2) {
			selectedNodeIds = this.multiSelectedNodes.slice();
		}

		// If right-clicking on a node not in the current selection, decide what to do
		if (nodeAtClick != null && selectedNodeIds.indexOf(nodeAtClick) === -1) {
			if (selectedNodeIds.length <= 1) {
				// Single (or no) selection: select the right-clicked node instead
				this.network.setSelection({ nodes: [nodeAtClick], edges: [] });
				this.multiSelectedNodes = [nodeAtClick];
				selectedNodeIds = [nodeAtClick];
			} else {
				// Multiple nodes selected and right-clicked node is not among them.
				// Allow ProductNode context menu (e.g. 'Select Production Tree') even so.
				const rightClickedGraphNode = result.graph.nodes.find(
					(n) => n.id === nodeAtClick,
				);
				if (
					!(
						rightClickedGraphNode &&
						rightClickedGraphNode instanceof ProductNode
					)
				) {
					return;
				}
			}
		}
		// Multi-select mode: right-clicked node is selected AND other nodes are also selected
		const isMultiSelect =
			selectedNodeIds.length > 1 &&
			nodeAtClick != null &&
			selectedNodeIds.indexOf(nodeAtClick) !== -1;

		if (nodeAtClick != null) {
			// --- Right-clicked on a node ---
			const nodeId = nodeAtClick;

			// Check if it's a combined link node
			const combinedGroupIndex = this.combinedLinkGroups.findIndex(
				(g) => g.combinedOutId === nodeId || g.combinedInId === nodeId,
			);
			if (combinedGroupIndex !== -1) {
				// Allow uncombine when single-select, or when the only selected nodes
				// are both ends of the same combined link group.
				const combinedGroup = this.combinedLinkGroups[combinedGroupIndex];
				const isBothEndsSelected =
					selectedNodeIds.length === 2 &&
					selectedNodeIds.indexOf(combinedGroup.combinedOutId) !== -1 &&
					selectedNodeIds.indexOf(combinedGroup.combinedInId) !== -1;

				// 'Go to Other Side' — navigate viewport to the paired combined link node
				const isCombinedOutSide = combinedGroup.combinedOutId === nodeId;
				const otherCombinedNodeId = isCombinedOutSide
					? combinedGroup.combinedInId
					: combinedGroup.combinedOutId;
				if (!isMultiSelect) {
					items.push({
						label: isCombinedOutSide ? 'Go to Link In' : 'Go to Link Out',
						icon: 'fa-crosshairs',
						action: () => {
							this.hideContextMenu();
							this.moveViewportToNode(otherCombinedNodeId);
						},
					});
				}

				if (!isMultiSelect || isBothEndsSelected) {
					items.push({
						label: 'Uncombine Link Nodes',
						icon: 'fa-expand-arrows-alt',
						action: () => {
							this.hideContextMenu();
							this.uncombineCombinedGroup(
								combinedGroupIndex,
								nodes,
								edges,
								result,
							);
						},
					});
				}
			}

			// Check if it's a split node
			const splitGroupIndex = this.splitGroups.findIndex(
				(g) => g.splitNodeIds.indexOf(nodeId) !== -1,
			);
			if (splitGroupIndex !== -1 && !isMultiSelect) {
				items.push({
					label: 'Recombine Split Recipe',
					icon: 'fa-compress-arrows-alt',
					action: () => {
						this.hideContextMenu();
						this.combineSplitGroup(splitGroupIndex, nodes, edges);
					},
				});
			}

			// Check if it's a link node
			const pairIndex = this.linkPairs.findIndex(
				(p) => p.linkOutId === nodeId || p.linkInId === nodeId,
			);
			if (pairIndex !== -1) {
				// Only show 'Recombine Link' when a single link node is selected,
				// or when exactly the 2 ends of the same link pair are selected.
				const pair = this.linkPairs[pairIndex];
				const isSingleSelect = selectedNodeIds.length <= 1;
				const isSamePairBothEnds =
					selectedNodeIds.length === 2 &&
					selectedNodeIds.indexOf(pair.linkOutId) !== -1 &&
					selectedNodeIds.indexOf(pair.linkInId) !== -1;

				// 'Go to Other Side' — navigate viewport to the paired link node
				const isOutSide = pair.linkOutId === nodeId;
				const otherLinkNodeId = isOutSide ? pair.linkInId : pair.linkOutId;
				if (!isMultiSelect) {
					items.push({
						label: isOutSide ? 'Go to Link In' : 'Go to Link Out',
						icon: 'fa-crosshairs',
						action: () => {
							this.hideContextMenu();
							this.moveViewportToNode(otherLinkNodeId);
						},
					});
				}

				if (isSingleSelect || isSamePairBothEnds) {
					items.push({
						label: 'Recombine Link',
						icon: 'fa-unlink',
						action: () => {
							this.hideContextMenu();
							this.removeLinkPair(pairIndex, nodes, edges);
						},
					});
				}
			}

			// Check if it's a RecipeNode (only when single-select)
			const graphNode = result.graph.nodes.find((n) => n.id === nodeId);
			if (graphNode && graphNode instanceof RecipeNode && !isMultiSelect) {
				// Split by output (if eligible: any output item appears on 2+ output edges)
				if (!this.splitGroups.some((g) => g.originalNodeId === nodeId)) {
					const outputEdges = result.graph.edges.filter(
						(e) => e.from.id === nodeId,
					);
					// Count how many effective edges each output item appears on
					// (combined links count as a single edge, not multiple)
					const outItemEdgeCount = this.countEffectiveEdgesPerItem(outputEdges, nodeId);
					// Find output items that appear on 2+ edges
					const duplicatedOutItems = Object.keys(outItemEdgeCount).filter(
						(item) => outItemEdgeCount[item] >= 2,
					);
					for (const dupItem of duplicatedOutItems) {
						const dupItemName = model.getItem(dupItem).prototype.name;
						items.push({
							label: 'Split Recipe by Output: ' + dupItemName,
							icon: 'fa-code-branch',
							action: ((itemToSplit: string) => () => {
								this.hideContextMenu();
								this.splitRecipeByOutput(
									nodeId,
									graphNode as RecipeNode,
									nodes,
									edges,
									result,
									itemToSplit,
								);
							})(dupItem),
						});
					}
				}
				// Split by input (if eligible: any input item appears on 2+ input edges)
				if (!this.splitGroups.some((g) => g.originalNodeId === nodeId)) {
					const inputEdges = result.graph.edges.filter(
						(e) => e.to.id === nodeId,
					);
					// Count how many effective edges each item appears on
					// (combined links count as a single edge, not multiple)
					const itemEdgeCount = this.countEffectiveEdgesPerItem(inputEdges, nodeId);
					// Find items that appear on 2+ edges
					const duplicatedItems = Object.keys(itemEdgeCount).filter(
						(item) => itemEdgeCount[item] >= 2,
					);
					for (const dupItem of duplicatedItems) {
						const dupItemName = model.getItem(dupItem).prototype.name;
						items.push({
							label: 'Split Recipe by Input: ' + dupItemName,
							icon: 'fa-code-branch',
							action: ((itemToSplit: string) => () => {
								this.hideContextMenu();
								this.splitRecipeByInput(
									nodeId,
									graphNode as RecipeNode,
									nodes,
									edges,
									result,
									itemToSplit,
								);
							})(dupItem),
						});
					}
				}
			}

			// Check if it's a ProductNode (always available)
			if (graphNode && graphNode instanceof ProductNode) {
				items.push({
					label: 'Select production tree',
					icon: 'fa-project-diagram',
					action: () => {
						this.hideContextMenu();
						this.selectProductionTree(nodeId, result);
					},
				});
			}

// Check if it's an IntermediateNode, InputNode, or MinerNode (only when single-select)
if (
graphNode &&
(graphNode instanceof IntermediateNode ||
graphNode instanceof InputNode ||
graphNode instanceof MinerNode) &&
!isMultiSelect
) {
const intermediateKey = getNodeKey(graphNode);
				const connectedEdges = result.graph.edges.filter(
					(e) => e.from.id === nodeId || e.to.id === nodeId,
				);
				const hasLinkableEdges = connectedEdges.some((graphEdge) => {
					const desc: ILinkNodeDescriptor = {
						fromNodeKey: getNodeKey(graphEdge.from),
						toNodeKey: getNodeKey(graphEdge.to),
						itemClassName: graphEdge.itemAmount.item,
					};
					const alreadyLinked = this.linkPairs.some(
						(p) =>
							p.descriptor.fromNodeKey === desc.fromNodeKey &&
							p.descriptor.toNodeKey === desc.toNodeKey &&
							p.descriptor.itemClassName === desc.itemClassName,
					);
					const isLinkEdge = this.linkPairs.some(
						(p) => p.outEdgeId === graphEdge.id || p.inEdgeId === graphEdge.id,
					);
					return !alreadyLinked && !isLinkEdge;
				});
				if (hasLinkableEdges) {
					items.push({
						label: 'Create Links for All Edges',
						icon: 'fa-link',
						action: () => {
							this.hideContextMenu();
							this.handleNodeDoubleClick(nodeId, nodes, edges, result);
						},
					});
				}

				// Recombine All Links: show when the intermediate has any attached link pairs
				const attachedLinkPairIndices: number[] = [];
				for (let i = 0; i < this.linkPairs.length; i++) {
					const p = this.linkPairs[i];
					if (
						p.descriptor.fromNodeKey === intermediateKey ||
						p.descriptor.toNodeKey === intermediateKey
					) {
						attachedLinkPairIndices.push(i);
					}
				}
				if (attachedLinkPairIndices.length > 0) {
					items.push({
						label: 'Recombine All Links',
						icon: 'fa-unlink',
						action: () => {
							this.hideContextMenu();
							this.recombineAllLinksForNode(
								attachedLinkPairIndices,
								nodes,
								edges,
							);
						},
					});
				}
			}

			// Combine links option when multiple link/combined nodes are selected
			if (
				selectedNodeIds.length >= 2 &&
				this.canCombineSelection(selectedNodeIds)
			) {
				items.push({
					label: 'Combine Selected Link Nodes',
					icon: 'fa-object-group',
					action: () => {
						this.hideContextMenu();
						this.handleCombineLinks(selectedNodeIds, nodes, edges, result);
						this.multiSelectedNodes = [];
					},
				});
			}
		} else if (edgeAtClick != null) {
			// --- Right-clicked on an edge ---
			const visEdgeId = edgeAtClick;

			if (selectedNodeIds.length > 1) {
				// Multiple nodes selected — don't show edge menu
			} else {
				// If a single node/edge was selected, deselect it
				if (selectedNodeIds.length === 1) {
					this.network.unselectAll();
					this.multiSelectedNodes = [];
				}

				// Don't allow creating link on a link edge
				const isLinkEdge = this.linkPairs.some(
					(p) => p.outEdgeId === visEdgeId || p.inEdgeId === visEdgeId,
				);
				if (isLinkEdge) {
					// Offer to recombine the link pair this edge belongs to
					const linkPairIndex = this.linkPairs.findIndex(
						(p) => p.outEdgeId === visEdgeId || p.inEdgeId === visEdgeId,
					);
					if (linkPairIndex !== -1) {
						items.push({
							label: 'Recombine Link',
							icon: 'fa-unlink',
							action: () => {
								this.hideContextMenu();
								this.removeLinkPair(linkPairIndex, nodes, edges);
							},
						});
					}
				} else if (!isLinkEdge) {
					// Check if it's a split edge
					const splitGroup = this.splitGroups.find(
						(g) => g.splitEdgeIds.indexOf(visEdgeId) !== -1,
					);
					if (splitGroup) {
						items.push({
							label: 'Create Link',
							icon: 'fa-link',
							action: () => {
								this.hideContextMenu();
								this.handleSplitEdgeDoubleClick(
									visEdgeId,
									splitGroup,
									nodes,
									edges,
									result,
								);
							},
						});
					} else {
						// Normal graph edge
						const graphEdge = result.graph.edges.find(
							(e) => e.id === visEdgeId,
						);
						if (graphEdge) {
							const descriptor: ILinkNodeDescriptor = {
								fromNodeKey: getNodeKey(graphEdge.from),
								toNodeKey: getNodeKey(graphEdge.to),
								itemClassName: graphEdge.itemAmount.item,
							};
							const alreadyLinked = this.linkPairs.some(
								(p) =>
									p.descriptor.fromNodeKey === descriptor.fromNodeKey &&
									p.descriptor.toNodeKey === descriptor.toNodeKey &&
									p.descriptor.itemClassName === descriptor.itemClassName,
							);
							if (!alreadyLinked) {
								items.push({
									label: 'Create Link',
									icon: 'fa-link',
									action: () => {
										this.hideContextMenu();
										this.handleEdgeDoubleClick(visEdgeId, nodes, edges, result);
									},
								});
							}
						}
					}
				}
			}
		}

		// If multi-selected link/combined nodes, show combine option even when clicking on background
		if (
			items.length === 0 &&
			selectedNodeIds.length >= 2 &&
			this.canCombineSelection(selectedNodeIds)
		) {
			items.push({
				label: 'Combine Selected Link Nodes',
				icon: 'fa-object-group',
				action: () => {
					this.hideContextMenu();
					this.handleCombineLinks(selectedNodeIds, nodes, edges, result);
					this.multiSelectedNodes = [];
				},
			});
		}

		if (items.length === 0) {
			return;
		}

		// Position the context menu relative to the component element
		const containerRect = this.$element[0].getBoundingClientRect();
		const eventX =
			(params.event as MouseEvent).clientX ||
			(params.event.center && params.event.center.x) ||
			0;
		const eventY =
			(params.event as MouseEvent).clientY ||
			(params.event.center && params.event.center.y) ||
			0;

		this.contextMenu = {
			visible: true,
			x: eventX - containerRect.left,
			y: eventY - containerRect.top,
			items: items,
		};
		this.$scope.$apply();
	}

	private hideContextMenu(): void {
		if (this.contextMenu.visible) {
			this.contextMenu.visible = false;
			this.contextMenu.items = [];
		}
	}

	/**
	 * Select all upstream nodes needed to fully produce the product at the given
	 * ProductNode. Traverses the production graph backwards (upstream) from the
	 * product node through recipe nodes, intermediate nodes, miner nodes, and
	 * input nodes. The selection is additive — selected nodes are added to the
	 * current selection so the action can be invoked on multiple product nodes
	 * in succession.
	 */
	private selectProductionTree(
		productNodeId: number,
		result: ProductionResult,
	): void {
		if (!this.network) {
			return;
		}

		// Build a set of linked edge descriptors (from linkPairs and combinedLinkGroups)
		// so the BFS stops at link boundaries.
		const linkedEdgeKeys = new Set<string>();
		for (const pair of this.linkPairs) {
			const key =
				pair.descriptor.fromNodeKey +
				'||' +
				pair.descriptor.toNodeKey +
				'||' +
				pair.descriptor.itemClassName;
			linkedEdgeKeys.add(key);
		}
		for (const group of this.combinedLinkGroups) {
			for (const origPair of group.originalPairs) {
				const key =
					origPair.descriptor.fromNodeKey +
					'||' +
					origPair.descriptor.toNodeKey +
					'||' +
					origPair.descriptor.itemClassName;
				linkedEdgeKeys.add(key);
			}
		}

		// BFS upstream through the graph edges, stopping at linked edges
		const visited = new Set<number>();
		const linkedVisNodeIds: number[] = []; // link/combined-link nodes on 'our' side
		const queue: number[] = [productNodeId];
		visited.add(productNodeId);

		while (queue.length > 0) {
			const currentId = queue.shift()!;

			// Find all graph edges where edge.to.id === currentId (upstream suppliers)
			for (const edge of result.graph.edges) {
				if (edge.to.id === currentId && !visited.has(edge.from.id)) {
					// Skip edges that have been replaced by link nodes
					const edgeKey =
						getNodeKey(edge.from) +
						'||' +
						getNodeKey(edge.to) +
						'||' +
						edge.itemAmount.item;
					if (linkedEdgeKeys.has(edgeKey)) {
						// Include the link-in node on our (downstream) side of the link
						// Check regular link pairs first
						const linkPair = this.linkPairs.find(
							(p) =>
								p.descriptor.fromNodeKey === getNodeKey(edge.from) &&
								p.descriptor.toNodeKey === getNodeKey(edge.to) &&
								p.descriptor.itemClassName === edge.itemAmount.item,
						);
						if (linkPair) {
							linkedVisNodeIds.push(linkPair.linkInId);
						} else {
							// Check combined link groups
							const combinedGroup = this.combinedLinkGroups.find((g) =>
								g.originalPairs.some(
									(p) =>
										p.descriptor.fromNodeKey === getNodeKey(edge.from) &&
										p.descriptor.toNodeKey === getNodeKey(edge.to) &&
										p.descriptor.itemClassName === edge.itemAmount.item,
								),
							);
							if (combinedGroup) {
								linkedVisNodeIds.push(combinedGroup.combinedInId);
							}
						}
						continue;
					}
					visited.add(edge.from.id);
					queue.push(edge.from.id);
				}
			}
		}

		// Map graph node IDs to vis-network node IDs, accounting for split nodes.
		// When a recipe node has been split, the original node ID is removed from
		// the vis DataSet and replaced by split node IDs.
		const visNodeIds: number[] = [];
		for (const graphNodeId of Array.from(visited)) {
			const splitGroup = this.splitGroups.find(
				(g) => g.originalNodeId === graphNodeId,
			);
			if (splitGroup) {
				// The original node was split — select all its split nodes instead
				for (const splitId of splitGroup.splitNodeIds) {
					visNodeIds.push(splitId);
				}
			} else {
				visNodeIds.push(graphNodeId);
			}
		}
		// Include link/combined-link nodes on our side of the boundary
		for (const linkNodeId of linkedVisNodeIds) {
			visNodeIds.push(linkNodeId);
		}

		// Merge with the current selection (additive)
		const currentSelection = (
			this.network.getSelectedNodes() as number[]
		).slice();
		const merged = new Set<number>(currentSelection);
		for (const id of visNodeIds) {
			merged.add(id);
		}
		const finalSelection = Array.from(merged);

		this.network.setSelection(
			{ nodes: finalSelection, edges: [] },
			{ unselectAll: false, highlightEdges: false },
		);
		this.multiSelectedNodes = finalSelection.slice();
	}

	/**
	 * Move the viewport to center on a specific node, keeping the current zoom level.
	 * Also selects the target node so it's highlighted.
	 */
	private moveViewportToNode(nodeId: number): void {
		if (!this.network) {
			return;
		}
		const positions = this.network.getPositions([nodeId]);
		const pos = positions[nodeId];
		if (!pos) {
			return;
		}
		const currentScale = this.network.getScale();
		this.network.moveTo({
			position: { x: pos.x, y: pos.y },
			scale: currentScale,
			animation: {
				duration: 500,
				easingFunction: 'easeInOutQuad',
			},
		});
		this.network.setSelection({ nodes: [nodeId], edges: [] });
		this.multiSelectedNodes = [nodeId];
	}

	private removeLinkPair(
		pairIndex: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
	): void { LinkOps.removeLinkPair(this, pairIndex, nodes, edges); }

	private recombineAllLinksForNode(
		pairIndices: number[],
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
	): void { LinkOps.recombineAllLinksForNode(this, pairIndices, nodes, edges); }

	// ==================== Link Node Methods ====================

	private handleEdgeDoubleClick(
		visEdgeId: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void { LinkOps.handleEdgeDoubleClick(this, visEdgeId, nodes, edges, result); }

	private handleSplitEdgeDoubleClick(
		visEdgeId: number,
		splitGroup: ISplitGroup,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void { LinkOps.handleSplitEdgeDoubleClick(this, visEdgeId, splitGroup, nodes, edges, result); }

	private handleNodeDoubleClick(
		nodeId: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void { LinkOps.handleNodeDoubleClick(this, nodeId, nodes, edges, result); }

	private createLinkPair(
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
	): ILinkPair { return LinkOps.createLinkPair(this, nodes, edges, fromVisId, toVisId, originalEdgeData, descriptor, itemClassName, itemAmount, fromPos, toPos, fromDisplayName, toDisplayName); }

	/**
	 * Determine the color a link node should use based on the 'other side' of the link.
	 * Each link node matches the color of the node on the far end of the link gap.
	 * Exception: if the other side is a recipe node, use the default link color.
	 */
	private getOtherSideLinkColor(
		otherNodeKey: string,
		otherVisId: number,
		nodes: DataSet<IVisNode>,
		defaultColor: any,
	): any { return LinkOps.getOtherSideLinkColor(otherNodeKey, otherVisId, nodes, defaultColor); }

	// ==================== Combined Link Methods ====================

	/**
	 * Count the effective number of edges per item for split eligibility,
	 * treating edges that belong to the same combined link group as a single edge.
	 */
	private countEffectiveEdgesPerItem(graphEdges: any[], nodeId?: number): {
		[item: string]: number;
	} { return CombinedOps.countEffectiveEdgesPerItem(this, graphEdges, nodeId); }

	/**
	 * Count how many vis edges a single graph edge effectively represents,
	 * accounting for the OTHER endpoint being in a split group. When the
	 * other endpoint has been split, non-primary edges are duplicated to
	 * all split nodes, so 1 graph edge becomes N vis edges.
	 *
	 * @param isFromNode true when the node we're checking is the FROM side
	 *                   of the edge (output direction)
	 */
	private countVisEdgesForSplitEligibility(
		graphEdge: any,
		isFromNode: boolean,
	): number { return CombinedOps.countVisEdgesForSplitEligibility(this, graphEdge, isFromNode); }

	/**
	 * Get combined link groups whose nodes are among the selected node IDs.
	 */
	private getSelectedCombinedGroups(
		selectedNodeIds: number[],
	): ICombinedLinkGroup[] { return CombinedOps.getSelectedCombinedGroups(this, selectedNodeIds); }

	/**
	 * Check whether the current selection (regular link pairs + combined link groups)
	 * can be combined into a (larger) combined group.
	 * Requires at least 2 distinct sources (individual pairs or combined groups).
	 */
	private canCombineSelection(selectedNodeIds: number[]): boolean { return CombinedOps.canCombineSelection(this, selectedNodeIds); }

	/**
	 * Get unique link pairs corresponding to the selected node IDs.
	 */
	private getSelectedLinkPairs(selectedNodeIds: number[]): ILinkPair[] { return CombinedOps.getSelectedLinkPairs(this, selectedNodeIds); }

	private handleCombineLinks(
		selectedNodeIds: number[],
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void { CombinedOps.handleCombineLinks(this, selectedNodeIds, nodes, edges, result); }

	private tryCombinePairs(
		pairs: ILinkPair[],
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void { CombinedOps.tryCombinePairs(this, pairs, nodes, edges, result); }

	private combineLinksGroup(
		pairs: ILinkPair[],
		type: 'out' | 'in',
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void { CombinedOps.combineLinksGroup(this, pairs, type, nodes, edges, result); }

	private uncombineCombinedGroup(
		groupIndex: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void { CombinedOps.uncombineCombinedGroup(this, groupIndex, nodes, edges, result); }

	private applyStoredCombinedLinks(
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		descriptors: ICombinedLinkDescriptor[],
	): void { CombinedOps.applyStoredCombinedLinks(this, nodes, edges, result, descriptors); }

	// ==================== Unified Graph State Persistence ====================

	private saveGraphStateForTab(tabId: string): void { saveGraphStateForTabFn(this, tabId, this.frozen, this._suppressSave); }

	private loadGraphState(): IGraphTabState { return loadGraphStateFn(this.tabId); }

	private applyStoredLinks(
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		descriptors: ILinkNodeDescriptor[],
	): void { LinkOps.applyStoredLinks(this, nodes, edges, result, descriptors); }

	private applyStoredSplitEdgeLink(
		descriptor: ILinkNodeDescriptor,
		graphEdge: any,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		overrideAmount?: number,
	): boolean { return LinkOps.applyStoredSplitEdgeLink(this, descriptor, graphEdge, nodes, edges, result, overrideAmount); }

	// ==================== Split Node Methods ====================

	private splitRecipeByOutput(
		nodeId: number,
		recipeNode: RecipeNode,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		itemToSplit?: string,
	): void { SplitOps.splitRecipeByOutput(this, nodeId, recipeNode, nodes, edges, result, itemToSplit); }

	private splitRecipeByInput(
		nodeId: number,
		recipeNode: RecipeNode,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		itemToSplit?: string,
	): void { SplitOps.splitRecipeByInput(this, nodeId, recipeNode, nodes, edges, result, itemToSplit); }

	private splitRecipeByDirection(
		nodeId: number,
		recipeNode: RecipeNode,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		splitType: 'output' | 'input',
		itemToSplit?: string,
	): void { SplitOps.splitRecipeByDirection(this, nodeId, recipeNode, nodes, edges, result, splitType, itemToSplit); }

	/**
	 * Find a split edge connecting a split node to/from the other node for a specific item.
	 */
	private findSplitEdgeForLink(
		splitNodeId: number,
		otherNodeId: number,
		isFromRecipe: boolean,
		itemClassName: string,
		group: ISplitGroup,
		edges: DataSet<IVisEdge>,
	): any | null { return SplitOps.findSplitEdgeForLink(splitNodeId, otherNodeId, isFromRecipe, itemClassName, group, edges); }

	/**
	 * Build hover tooltip element for a split node, matching RecipeNode.getTooltip() format.
	 */
	private buildSplitNodeTooltip(
		recipeNode: RecipeNode,
		splitAmount: number,
	): HTMLElement { return SplitOps.buildSplitNodeTooltip(recipeNode, splitAmount); }

	/**
	 * Build a scaled edge data object for a duplicated edge on a split node.
	 * @param edgeId - New edge ID
	 * @param originalVisEdge - The original vis edge data being duplicated
	 * @param splitNodeId - The split node ID to connect to/from
	 * @param fraction - Scale fraction for amounts
	 * @param result - Production result for looking up graph edge amounts
	 * @param splitNodeIsFrom - If true, splitNodeId is the 'from'; otherwise it's the 'to'
	 */
	private buildScaledSplitEdge(
		edgeId: number,
		originalVisEdge: any,
		splitNodeId: number,
		fraction: number,
		result: ProductionResult,
		splitNodeIsFrom: boolean,
		resolvedGraphEdge?: any,
		baseAmountMultiplier?: number,
	): any { return SplitOps.buildScaledSplitEdge(edgeId, originalVisEdge, splitNodeId, fraction, result, splitNodeIsFrom, resolvedGraphEdge, baseAmountMultiplier); }

	/**
	 * Resolve a vis edge to its corresponding graph edge, accounting for vis edges
	 * that are split edges from other split groups (whose IDs don't match any
	 * graph edge ID directly).
	 */
	private resolveVisEdgeToGraphEdge(
		visEdge: any,
		nodeId: number,
		result: ProductionResult,
	): {
		graphEdge: any;
		splitGroup: ISplitGroup | null;
		splitNodeIndex: number;
	} | null { return SplitOps.resolveVisEdgeToGraphEdge(this, visEdge, nodeId, result); }

	/**
	 * Compute the split fraction that a specific split node represents
	 * within its split group.
	 */
	private getSplitNodeFraction(
		sg: ISplitGroup,
		splitNodeIndex: number,
		result: ProductionResult,
	): number { return SplitOps.getSplitNodeFraction(sg, splitNodeIndex, result); }

	private combineSplitGroup(
		groupIndex: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
	): void { SplitOps.combineSplitGroup(this, groupIndex, nodes, edges); }

	private getVisEdgesForNode(nodeId: number, edges: DataSet<IVisEdge>): any[] { return SplitOps.getVisEdgesForNode(nodeId, edges); }

	private applyStoredSplits(
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		descriptors: ISplitDescriptor[],
	): void { SplitOps.applyStoredSplits(this, nodes, edges, result, descriptors); }

	// ==================== Existing Methods ====================

	private hasSavedPositionsForGraph(
		savedPositions: { [key: string]: { x: number; y: number } },
		result: ProductionResult,
	): boolean { return hasSavedPositionsForGraphFn(savedPositions, result); }

	private getGraphContainer(): HTMLElement {
		if (!this.graphContainer) {
			this.graphContainer = this.$element[0].querySelector(
				'.custom-graph-container',
			);
		}
		return this.graphContainer;
	}

	private drawVisualisation(
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
	): Network {
		return new Network(
			this.getGraphContainer(),
			{
				nodes: nodes,
				edges: edges,
			},
			{
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
			},
		);
	}
}
