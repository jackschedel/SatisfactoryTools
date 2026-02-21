import { DataSet, Network } from "vis-network";
import {
	IController,
	IIntervalService,
	IPromise,
	IScope,
	ITimeoutService,
} from "angular";
import ELK from "elkjs/lib/elk.bundled";
import { IVisNode } from "@src/Tools/Production/Result/IVisNode";
import { IVisEdge } from "@src/Tools/Production/Result/IVisEdge";
import { IElkGraph } from "@src/Solver/IElkGraph";
import { Strings } from "@src/Utils/Strings";
import model from "@src/Data/Model";
import { ProductionResult } from "@src/Tools/Production/Result/ProductionResult";
import { GraphNode } from "@src/Tools/Production/Result/Nodes/GraphNode";
import { RecipeNode } from "@src/Tools/Production/Result/Nodes/RecipeNode";
import { InputNode } from "@src/Tools/Production/Result/Nodes/InputNode";
import { MinerNode } from "@src/Tools/Production/Result/Nodes/MinerNode";
import { ProductNode } from "@src/Tools/Production/Result/Nodes/ProductNode";
import { ByproductNode } from "@src/Tools/Production/Result/Nodes/ByproductNode";
import { SinkNode } from "@src/Tools/Production/Result/Nodes/SinkNode";
import { GeneratorNode } from "@src/Tools/Production/Result/Nodes/GeneratorNode";
import { IntermediateNode } from "@src/Tools/Production/Result/Nodes/IntermediateNode";
import { ILinkNodeDescriptor } from "@src/Tools/Production/IProductionData";
import { Numbers } from "@src/Utils/Numbers";
import { RecipeData } from "@src/Tools/Production/Result/RecipeData";
import { MachineGroup } from "@src/Tools/Production/Result/MachineGroup";

interface ILinkPair {
	linkOutId: number;
	linkInId: number;
	outEdgeId: number;
	inEdgeId: number;
	originalEdgeData: any;
	descriptor: ILinkNodeDescriptor;
	amount?: number;
}

interface ISplitDescriptor {
	recipeNodeKey: string;
	splitType: "output" | "input";
	splitItemClassName?: string;
	splitNodePositions?: { [index: string]: { x: number; y: number } };
}

interface ISplitGroup {
	originalNodeId: number;
	originalNodeData: any;
	originalEdgesData: any[];
	splitNodeIds: number[];
	splitEdgeIds: number[];
	descriptor: ISplitDescriptor;
}

interface ICombinedLinkDescriptor {
	type: "out" | "in";
	itemClassName: string;
	sourceKey: string;
	originalDescriptors: ILinkNodeDescriptor[];
	combinedOutPos?: { x: number; y: number };
	combinedInPos?: { x: number; y: number };
}

interface ICombinedLinkGroup {
	type: "out" | "in";
	itemClassName: string;
	sourceKey: string;
	originalPairs: ILinkPair[];
	combinedOutId: number;
	combinedInId: number;
	combinedEdgeIds: number[];
	descriptor: ICombinedLinkDescriptor;
}

function getNodeKey(node: GraphNode): string {
	if (node instanceof RecipeNode) {
		return "recipe:" + node.recipeData.recipe.className;
	}
	if (node instanceof InputNode) {
		return "input:" + node.itemAmount.item;
	}
	if (node instanceof MinerNode) {
		return "miner:" + node.itemAmount.item;
	}
	if (node instanceof ProductNode) {
		return "product:" + node.itemAmount.item;
	}
	if (node instanceof ByproductNode) {
		return "byproduct:" + node.itemAmount.item;
	}
	if (node instanceof SinkNode) {
		return "sink:" + node.itemAmount.item;
	}
	if (node instanceof GeneratorNode) {
		return "generator:" + node.generatorData.fuel.className;
	}
	if (node instanceof IntermediateNode) {
		return "intermediate:" + node.resource.className;
	}
	return "node:" + node.id;
}

function getNodeDisplayName(node: GraphNode): string {
	if (node instanceof RecipeNode) {
		return node.recipeData.recipe.name;
	}
	if (node instanceof InputNode) {
		return "Input: " + node.resource.name;
	}
	if (node instanceof MinerNode) {
		return node.resource.name;
	}
	if (node instanceof ProductNode) {
		return node.resource.name;
	}
	if (node instanceof ByproductNode) {
		return "Byproduct: " + node.resource.name;
	}
	if (node instanceof SinkNode) {
		return "Sink: " + node.resource.name;
	}
	if (node instanceof GeneratorNode) {
		return node.generatorData.fuel.name;
	}
	if (node instanceof IntermediateNode) {
		return node.resource.name;
	}
	return "Node " + node.id;
}

export class CustomGraphComponentController implements IController {
	public result: ProductionResult;
	public tabId: string;
	public intermediateItems: string[];
	public frozen: boolean = false;
	public exportMessage: string = "";

	public static $inject = ["$element", "$scope", "$timeout", "$interval"];

	private unregisterWatcherCallback: () => void;
	private unregisterTabIdWatcherCallback: () => void;
	private unregisterIntermediateWatcherCallback: () => void;
	private network: Network;
	private fitted: boolean = false;
	private interval: IPromise<any>;
	private frozenResult: ProductionResult | undefined;
	private graphContainer: HTMLElement;

	// Link node tracking
	private linkPairs: ILinkPair[] = [];
	private linkNodeIdCounter: number = 100000;
	private linkEdgeIdCounter: number = 200000;
	private nodesDataSet: DataSet<IVisNode> | null = null;
	private edgesDataSet: DataSet<IVisEdge> | null = null;
	private currentResult: ProductionResult | null = null;

	// Split node tracking
	private splitGroups: ISplitGroup[] = [];
	private splitNodeIdCounter: number = 300000;
	private splitEdgeIdCounter: number = 400000;

	// Combined link tracking
	private combinedLinkGroups: ICombinedLinkGroup[] = [];
	private combinedNodeIdCounter: number = 500000;
	private combinedEdgeIdCounter: number = 600000;

	// Context menu state
	public contextMenu: {
		visible: boolean;
		x: number;
		y: number;
		items: { label: string; icon: string; action: () => void }[];
	} = { visible: false, x: 0, y: 0, items: [] };

	// Multi-select tracking (shift or ctrl/cmd)
	private multiSelectedNodes: number[] = [];

	// Mapping from numeric node ID to stable node key for position persistence
	private nodeIdToKeyMap: { [id: number]: string } = {};

	// Temporary position map used to preserve node positions across intermediate node changes
	private preservedPositionsMap: {
		[key: string]: { x: number; y: number };
	} | null = null;

	private static readonly POSITIONS_STORAGE_KEY = "customGraphNodePositions";
	private static readonly FROZEN_STORAGE_KEY = "customGraphFrozenTabs";
	private static readonly LINK_NODES_STORAGE_KEY = "customGraphLinkNodes";
	private static readonly SPLIT_NODES_STORAGE_KEY = "customGraphSplitNodes";
	private static readonly COMBINED_LINKS_STORAGE_KEY =
		"customGraphCombinedLinks";

	public constructor(
		private readonly $element: any,
		private readonly $scope: IScope,
		private readonly $timeout: ITimeoutService,
		private readonly $interval: IIntervalService,
	) {}

	public $onInit(): void {
		this.frozen = this.loadFrozenState();
		let initialRenderDone = false;

		// Watch for tab changes — reload frozen state for the new tab
		this.unregisterTabIdWatcherCallback = this.$scope.$watch(
			() => {
				return this.tabId;
			},
			(newTabId, oldTabId) => {
				if (newTabId !== oldTabId) {
					// Save positions for the old tab before switching
					this.saveNodePositionsForTab(oldTabId);
					// Reload frozen state for the new tab
					this.frozen = this.loadFrozenState();
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
										"linkOut:" +
										pair.descriptor.fromNodeKey +
										"||" +
										pair.descriptor.toNodeKey +
										"||" +
										pair.descriptor.itemClassName;
									posMap[outKey] = rawPositions[pair.linkOutId];
								}
								if (rawPositions[pair.linkInId]) {
									const inKey =
										"linkIn:" +
										pair.descriptor.fromNodeKey +
										"||" +
										pair.descriptor.toNodeKey +
										"||" +
										pair.descriptor.itemClassName;
									posMap[inKey] = rawPositions[pair.linkInId];
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
					height: newHeight + "px",
				});
				this.network.fit();
			}
		}, 100);
	}

	public $onDestroy(): void {
		this.saveNodePositions();
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
			id: "root",
			layoutOptions: {
				"elk.algorithm": "org.eclipse.elk.layered",
				"org.eclipse.elk.layered.nodePlacement.favorStraightEdges":
					true as unknown as string,
				"org.eclipse.elk.spacing.nodeNode": 40 + "",
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
				id: "",
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
					this.exportMessage = "Copied to clipboard!";
				});
				this.$timeout(() => {
					this.exportMessage = "";
				}, 3000);
			});
		} else {
			const textarea = document.createElement("textarea");
			textarea.value = json;
			document.body.appendChild(textarea);
			textarea.select();
			document.execCommand("copy");
			document.body.removeChild(textarea);
			this.exportMessage = "Copied to clipboard!";
			this.$timeout(() => {
				this.exportMessage = "";
			}, 3000);
		}
	}

	public toggleFreeze(): void {
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
				smooth.type = "curvedCW";
				smooth.roundness = 0.2;
			}

			edges.add({
				id: edge.id,
				from: edge.from.id,
				to: edge.to.id,
				label:
					model.getItem(edge.itemAmount.item).prototype.name +
					"\n" +
					Strings.formatItemAmount(
						edge.itemAmount.amount,
						edge.itemAmount.item,
					),
				color: {
					color: "rgba(105, 125, 145, 1)",
					highlight: "rgba(134, 151, 167, 1)",
				},
				font: {
					color: "rgba(238, 238, 238, 1)",
				},
				smooth: smooth,
			} as any);
		}

		this.network = this.drawVisualisation(nodes, edges);

		this.network.on("dragEnd", () => {
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
				id: "root",
				layoutOptions: {
					"elk.algorithm": "org.eclipse.elk.layered",
					"org.eclipse.elk.layered.nodePlacement.favorStraightEdges":
						true as unknown as string,
					"org.eclipse.elk.spacing.nodeNode": 40 + "",
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
					id: "",
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

					// After ELK layout, check if we have preserved positions from an intermediate node change
					const preservedMap = this.preservedPositionsMap;
					this.preservedPositionsMap = null;
					let savedPositions = this.loadNodePositions();

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
								let attempts = 0;
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
						// Normal flow: restore saved positions if frozen and they match
						if (
							this.frozen &&
							this.savedPositionsMatchGraph(savedPositions, result)
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

					// Apply stored split nodes after layout/positions are set (before links, since links can be on split edges)
					this.applyStoredSplits(nodes, edges, result);

					// Apply stored link nodes after layout/positions are set
					this.applyStoredLinks(nodes, edges, result, savedPositions);

					// Apply stored combined links after layout/positions are set
					this.applyStoredCombinedLinks(nodes, edges, result);

					// Make Shift+click behave like Ctrl+click for vis-network's native
					// multi-select. vis-network (via Hammer.js) checks event.ctrlKey to
					// decide whether to add to selection. By overriding ctrlKey on the
					// DOM event in the capture phase (before Hammer.js sees it), Shift
					// becomes equivalent to Ctrl for selection purposes.
					const graphCanvas = this.getGraphContainer().querySelector("canvas");
					if (graphCanvas) {
						const patchShiftAsCtrl = (e: PointerEvent) => {
							if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
								Object.defineProperty(e, "ctrlKey", { get: () => true });
							}
						};
						graphCanvas.addEventListener("pointerdown", patchShiftAsCtrl, true);
						graphCanvas.addEventListener("pointerup", patchShiftAsCtrl, true);
					}

					// Register click handler for syncing multiSelectedNodes and context menu dismissal
					this.network.on("click", (params: any) => {
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
					this.network.on("oncontext", (params: any) => {
						params.event.preventDefault();
						this.showContextMenu(params, nodes, edges, result);
					});

					// Save positions after layout
					this.$timeout(100).then(() => {
						this.saveNodePositions();
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
        // Allow ProductNode context menu (e.g. "Select Production Tree") even so.
        const rightClickedGraphNode = result.graph.nodes.find(
          (n) => n.id === nodeAtClick,
        );
        if (!(rightClickedGraphNode && rightClickedGraphNode instanceof ProductNode)) {
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

				// "Go to Other Side" — navigate viewport to the paired combined link node
				const isCombinedOutSide = combinedGroup.combinedOutId === nodeId;
				const otherCombinedNodeId = isCombinedOutSide
					? combinedGroup.combinedInId
					: combinedGroup.combinedOutId;
				items.push({
					label: isCombinedOutSide ? "Go to Link In" : "Go to Link Out",
					icon: "fa-crosshairs",
					action: () => {
						this.hideContextMenu();
						this.moveViewportToNode(otherCombinedNodeId);
					},
				});

				if (!isMultiSelect || isBothEndsSelected) {
					items.push({
						label: "Uncombine Link Nodes",
						icon: "fa-expand-arrows-alt",
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
					label: "Recombine Split Recipe",
					icon: "fa-compress-arrows-alt",
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
				// Only show "Recombine Link" when a single link node is selected,
				// or when exactly the 2 ends of the same link pair are selected.
				const pair = this.linkPairs[pairIndex];
				const isSingleSelect = selectedNodeIds.length <= 1;
				const isSamePairBothEnds =
					selectedNodeIds.length === 2 &&
					selectedNodeIds.indexOf(pair.linkOutId) !== -1 &&
					selectedNodeIds.indexOf(pair.linkInId) !== -1;

				// "Go to Other Side" — navigate viewport to the paired link node
				const isOutSide = pair.linkOutId === nodeId;
				const otherLinkNodeId = isOutSide ? pair.linkInId : pair.linkOutId;
				items.push({
					label: isOutSide ? "Go to Link In" : "Go to Link Out",
					icon: "fa-crosshairs",
					action: () => {
						this.hideContextMenu();
						this.moveViewportToNode(otherLinkNodeId);
					},
				});

				if (isSingleSelect || isSamePairBothEnds) {
					items.push({
						label: "Recombine Link",
						icon: "fa-unlink",
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
					const outItemEdgeCount = this.countEffectiveEdgesPerItem(outputEdges);
					// Find output items that appear on 2+ edges
					const duplicatedOutItems = Object.keys(outItemEdgeCount).filter(
						(item) => outItemEdgeCount[item] >= 2,
					);
					for (const dupItem of duplicatedOutItems) {
						const dupItemName = model.getItem(dupItem).prototype.name;
						items.push({
							label: "Split Recipe by Output: " + dupItemName,
							icon: "fa-code-branch",
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
					const itemEdgeCount = this.countEffectiveEdgesPerItem(inputEdges);
					// Find items that appear on 2+ edges
					const duplicatedItems = Object.keys(itemEdgeCount).filter(
						(item) => itemEdgeCount[item] >= 2,
					);
					for (const dupItem of duplicatedItems) {
						const dupItemName = model.getItem(dupItem).prototype.name;
						items.push({
							label: "Split Recipe by Input: " + dupItemName,
							icon: "fa-code-branch",
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
					label: "Select production tree",
					icon: "fa-project-diagram",
					action: () => {
						this.hideContextMenu();
						this.selectProductionTree(nodeId, result);
					},
				});
			}

			// Check if it's an IntermediateNode (only when single-select)
			if (
				graphNode &&
				graphNode instanceof IntermediateNode &&
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
						label: "Create Links for All Edges",
						icon: "fa-link",
						action: () => {
							this.hideContextMenu();
							this.handleNodeDoubleClick(nodeId, nodes, edges, result, false);
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
						label: "Recombine All Links",
						icon: "fa-unlink",
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
					label: "Combine Selected Link Nodes",
					icon: "fa-object-group",
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
				if (!isLinkEdge) {
					// Check if it's a split edge
					const splitGroup = this.splitGroups.find(
						(g) => g.splitEdgeIds.indexOf(visEdgeId) !== -1,
					);
					if (splitGroup) {
						items.push({
							label: "Create Link",
							icon: "fa-link",
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
									label: "Create Link",
									icon: "fa-link",
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
				label: "Combine Selected Link Nodes",
				icon: "fa-object-group",
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
	 * Move the viewport to center on a specific node, keeping the current zoom level.
	 * Also selects the target node so it's highlighted.
	 */
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
        "||" +
        pair.descriptor.toNodeKey +
        "||" +
        pair.descriptor.itemClassName;
      linkedEdgeKeys.add(key);
    }
    for (const group of this.combinedLinkGroups) {
      for (const origPair of group.originalPairs) {
        const key =
          origPair.descriptor.fromNodeKey +
          "||" +
          origPair.descriptor.toNodeKey +
          "||" +
          origPair.descriptor.itemClassName;
        linkedEdgeKeys.add(key);
      }
    }

    // BFS upstream through the graph edges, stopping at linked edges
    const visited = new Set<number>();
    const linkedVisNodeIds: number[] = []; // link/combined-link nodes on "our" side
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
            "||" +
            getNodeKey(edge.to) +
            "||" +
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
				easingFunction: "easeInOutQuad",
			},
		});
		this.network.setSelection({ nodes: [nodeId], edges: [] });
		this.multiSelectedNodes = [nodeId];
	}

	private removeLinkPair(
		pairIndex: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
	): void {
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

	private recombineAllLinksForNode(
		pairIndices: number[],
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
	): void {
		// Process in reverse order so that splice indices remain valid
		const sorted = pairIndices.slice().sort((a, b) => b - a);
		for (const idx of sorted) {
			const pair = this.linkPairs[idx];
			if (!pair) {
				continue;
			}

			// Remove link edges
			edges.remove(pair.outEdgeId);
			edges.remove(pair.inEdgeId);

			// Remove link nodes
			nodes.remove(pair.linkOutId);
			nodes.remove(pair.linkInId);

			// Restore original edge
			edges.add(pair.originalEdgeData);

			// Remove from tracking
			this.linkPairs.splice(idx, 1);
		}

		this.saveLinkNodes();
		this.saveNodePositions();
	}

	// ==================== Link Node Methods ====================

	private handleEdgeDoubleClick(
		visEdgeId: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
		// Don't allow splitting a link edge
		if (
			this.linkPairs.some(
				(p) => p.outEdgeId === visEdgeId || p.inEdgeId === visEdgeId,
			)
		) {
			return;
		}

		// Check if this is a split edge — handle link creation on split edges
		const splitGroup = this.splitGroups.find(
			(g) => g.splitEdgeIds.indexOf(visEdgeId) !== -1,
		);
		if (splitGroup) {
			this.handleSplitEdgeDoubleClick(
				visEdgeId,
				splitGroup,
				nodes,
				edges,
				result,
			);
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

		if (
			this.linkPairs.some(
				(p) =>
					p.descriptor.fromNodeKey === descriptor.fromNodeKey &&
					p.descriptor.toNodeKey === descriptor.toNodeKey &&
					p.descriptor.itemClassName === descriptor.itemClassName,
			)
		) {
			return;
		}

		// Get the vis edge data for restoration later
		const originalEdgeData = edges.get(visEdgeId);
		if (!originalEdgeData) {
			return;
		}

		// Get node positions to calculate midpoint
		const positions = this.network.getPositions([
			graphEdge.from.id,
			graphEdge.to.id,
		]);
		const fromPos = positions[graphEdge.from.id];
		const toPos = positions[graphEdge.to.id];
		if (!fromPos || !toPos) {
			return;
		}

		this.createLinkPair(
			nodes,
			edges,
			graphEdge.from.id,
			graphEdge.to.id,
			originalEdgeData,
			descriptor,
			graphEdge.itemAmount.item,
			graphEdge.itemAmount.amount,
			fromPos,
			toPos,
			getNodeDisplayName(graphEdge.from),
			getNodeDisplayName(graphEdge.to),
		);

		this.saveLinkNodes();
		this.saveNodePositions();
	}

	private handleSplitEdgeDoubleClick(
		visEdgeId: number,
		splitGroup: ISplitGroup,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
		// Get the vis edge data
		const visEdge = edges.get(visEdgeId) as any;
		if (!visEdge) {
			return;
		}

		const fromId = visEdge.from as number;
		const toId = visEdge.to as number;

		// Determine which side is the split node
		const splitFromIndex = splitGroup.splitNodeIds.indexOf(fromId);
		const splitToIndex = splitGroup.splitNodeIds.indexOf(toId);
		const isSplitFrom = splitFromIndex !== -1;
		const splitNodeIndex = isSplitFrom ? splitFromIndex : splitToIndex;

		if (splitNodeIndex === -1) {
			return;
		}

		// Find the original recipe graph node
		const recipeGraphNode = result.graph.nodes.find(
			(n) => n.id === splitGroup.originalNodeId,
		);
		if (!recipeGraphNode) {
			return;
		}
		const recipeKey = getNodeKey(recipeGraphNode);

		// Find the corresponding original graph edge by substituting split node ID with recipe node ID
		const graphFromId = isSplitFrom ? splitGroup.originalNodeId : fromId;
		const graphToId = isSplitFrom ? toId : splitGroup.originalNodeId;

		const candidateEdges = result.graph.edges.filter(
			(e) => e.from.id === graphFromId && e.to.id === graphToId,
		);

		let graphEdge = candidateEdges.length === 1 ? candidateEdges[0] : null;

		// Disambiguate by matching item name from vis edge label
		if (!graphEdge && candidateEdges.length > 1) {
			const visEdgeLabelFirstLine = ((visEdge.label || "") as string)
				.split("\n")[0]
				.trim();
			graphEdge =
				candidateEdges.find(
					(e) =>
						model.getItem(e.itemAmount.item).prototype.name ===
						visEdgeLabelFirstLine,
				) || null;
		}

		if (!graphEdge) {
			return;
		}

		// Build descriptor
		const descriptor: ILinkNodeDescriptor = {
			fromNodeKey: getNodeKey(graphEdge.from),
			toNodeKey: getNodeKey(graphEdge.to),
			itemClassName: graphEdge.itemAmount.item,
			splitRecipeKey: recipeKey,
			splitNodeIndex: splitNodeIndex,
		};

		// Check if this exact split-edge link already exists
		if (
			this.linkPairs.some(
				(p) =>
					p.descriptor.fromNodeKey === descriptor.fromNodeKey &&
					p.descriptor.toNodeKey === descriptor.toNodeKey &&
					p.descriptor.itemClassName === descriptor.itemClassName &&
					p.descriptor.splitRecipeKey === descriptor.splitRecipeKey &&
					p.descriptor.splitNodeIndex === descriptor.splitNodeIndex,
			)
		) {
			return;
		}

		// Get positions for link node placement
		const positions = this.network.getPositions([fromId, toId]);
		const fromPos = positions[fromId];
		const toPos = positions[toId];
		if (!fromPos || !toPos) {
			return;
		}

		// Determine display names
		const otherNodeId = isSplitFrom ? toId : fromId;
		const otherGraphNode = result.graph.nodes.find((n) => n.id === otherNodeId);
		const otherName = otherGraphNode
			? getNodeDisplayName(otherGraphNode)
			: "Node";
		const splitNodeData = nodes.get(isSplitFrom ? fromId : toId);
		const splitName = splitNodeData
			? ((splitNodeData.label || "") as string)
					.replace(/<[^>]*>/g, "")
					.split("\n")[0]
					.trim() || "Split Node"
			: "Split Node";

		const fromDisplayName = isSplitFrom ? splitName : otherName;
		const toDisplayName = isSplitFrom ? otherName : splitName;

		// Compute the correct amount for this split edge.
		// Primary edges (split-item edges in the split direction) keep their original
		// per-edge amount. Non-primary edges (shared/duplicated edges) must be scaled
		// by the split fraction.
		let splitLinkAmount = graphEdge.itemAmount.amount;
		const splitItemClassName = splitGroup.descriptor.splitItemClassName;
		if (splitItemClassName) {
			const isOutputSplit = splitGroup.descriptor.splitType === "output";
			const isPrimaryEdge =
				graphEdge.itemAmount.item === splitItemClassName &&
				(isOutputSplit
					? graphEdge.from.id === splitGroup.originalNodeId
					: graphEdge.to.id === splitGroup.originalNodeId);

			if (!isPrimaryEdge) {
				const splitItemEdges = result.graph.edges.filter(
					(e) =>
						(isOutputSplit ? e.from.id : e.to.id) ===
							splitGroup.originalNodeId &&
						e.itemAmount.item === splitItemClassName,
				);
				const totalSplitAmount = splitItemEdges.reduce(
					(sum, e) => sum + e.itemAmount.amount,
					0,
				);
				if (totalSplitAmount > 0 && splitNodeIndex < splitItemEdges.length) {
					const fraction =
						splitItemEdges[splitNodeIndex].itemAmount.amount / totalSplitAmount;
					splitLinkAmount = graphEdge.itemAmount.amount * fraction;
				}
			}
		}

		this.createLinkPair(
			nodes,
			edges,
			fromId,
			toId,
			visEdge,
			descriptor,
			graphEdge.itemAmount.item,
			splitLinkAmount,
			fromPos,
			toPos,
			fromDisplayName,
			toDisplayName,
		);

		this.saveLinkNodes();
		this.saveNodePositions();
	}

	private handleNodeDoubleClick(
		nodeId: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		isShift: boolean = false,
	): void {
		// Check if it's a combined link node being uncombined
		const combinedGroupIndex = this.combinedLinkGroups.findIndex(
			(g) => g.combinedOutId === nodeId || g.combinedInId === nodeId,
		);
		if (combinedGroupIndex !== -1) {
			this.uncombineCombinedGroup(combinedGroupIndex, nodes, edges, result);
			return;
		}

		// Check if it's a split node being combined back
		const splitGroupIndex = this.splitGroups.findIndex(
			(g) => g.splitNodeIds.indexOf(nodeId) !== -1,
		);
		if (splitGroupIndex !== -1) {
			this.combineSplitGroup(splitGroupIndex, nodes, edges);
			return;
		}

		// Check if it's a link node being removed
		const pairIndex = this.linkPairs.findIndex(
			(p) => p.linkOutId === nodeId || p.linkInId === nodeId,
		);
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
				// Find first duplicated input item to split on
				const allInputEdges = result.graph.edges.filter(
					(e) => e.to.id === nodeId,
				);
				const itemEdgeCount: { [item: string]: number } = {};
				for (const e of allInputEdges) {
					itemEdgeCount[e.itemAmount.item] =
						(itemEdgeCount[e.itemAmount.item] || 0) + 1;
				}
				const candidates = Object.keys(itemEdgeCount).filter(
					(item) => itemEdgeCount[item] >= 2,
				);
				if (candidates.length > 0) {
					this.splitRecipeByInput(
						nodeId,
						graphNode,
						nodes,
						edges,
						result,
						candidates[0],
					);
				}
			} else {
				this.splitRecipeByOutput(nodeId, graphNode, nodes, edges, result);
			}
			return;
		}

		// Check if it's an IntermediateNode — auto-create links for all its edges
		if (graphNode && graphNode instanceof IntermediateNode) {
			const connectedEdges = result.graph.edges.filter(
				(e) => e.from.id === nodeId || e.to.id === nodeId,
			);
			let created = false;
			for (const graphEdge of connectedEdges) {
				// Skip edges that are already split
				const descriptor: ILinkNodeDescriptor = {
					fromNodeKey: getNodeKey(graphEdge.from),
					toNodeKey: getNodeKey(graphEdge.to),
					itemClassName: graphEdge.itemAmount.item,
				};
				if (
					this.linkPairs.some(
						(p) =>
							p.descriptor.fromNodeKey === descriptor.fromNodeKey &&
							p.descriptor.toNodeKey === descriptor.toNodeKey &&
							p.descriptor.itemClassName === descriptor.itemClassName,
					)
				) {
					continue;
				}

				// Don't allow splitting a link edge
				if (
					this.linkPairs.some(
						(p) => p.outEdgeId === graphEdge.id || p.inEdgeId === graphEdge.id,
					)
				) {
					continue;
				}

				const originalEdgeData = edges.get(graphEdge.id);
				if (!originalEdgeData) {
					continue;
				}

				const positions = this.network.getPositions([
					graphEdge.from.id,
					graphEdge.to.id,
				]);
				const fromPos = positions[graphEdge.from.id];
				const toPos = positions[graphEdge.to.id];
				if (!fromPos || !toPos) {
					continue;
				}

				this.createLinkPair(
					nodes,
					edges,
					graphEdge.from.id,
					graphEdge.to.id,
					originalEdgeData,
					descriptor,
					graphEdge.itemAmount.item,
					graphEdge.itemAmount.amount,
					fromPos,
					toPos,
					getNodeDisplayName(graphEdge.from),
					getNodeDisplayName(graphEdge.to),
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
		fromPos: { x: number; y: number },
		toPos: { x: number; y: number },
		fromDisplayName: string,
		toDisplayName: string,
	): ILinkPair {
		const midX = (fromPos.x + toPos.x) / 2;
		const midY = (fromPos.y + toPos.y) / 2;

		const itemName = model.getItem(itemClassName).prototype.name;
		const amountStr = Strings.formatItemAmount(itemAmount, itemClassName);
		const fromName = fromDisplayName;
		const toName = toDisplayName;

		const linkOutId = this.linkNodeIdCounter++;
		const linkInId = this.linkNodeIdCounter++;
		const outEdgeId = this.linkEdgeIdCounter++;
		const inEdgeId = this.linkEdgeIdCounter++;

		const outLabel =
			"<b>Link Out: " +
			itemName +
			"</b>\n<i>To: " +
			toName +
			"</i>\n" +
			amountStr;

		const inLabel =
			"<b>Link In: " +
			itemName +
			"</b>\n<i>From: " +
			fromName +
			"</i>\n" +
			amountStr;

		const linkNodeColor = {
			border: "rgba(0, 0, 0, 0)",
			background: "rgba(50, 160, 160, 1)",
			highlight: {
				border: "rgba(238, 238, 238, 1)",
				background: "rgba(80, 190, 190, 1)",
			},
		};
		const linkNodeFont = {
			color: "rgba(238, 238, 238, 1)",
		};

		// Add both nodes at the midpoint initially so vis-network computes their sizes
		nodes.add({
			id: linkOutId,
			label: outLabel,
			x: midX,
			y: midY,
			color: linkNodeColor,
			font: linkNodeFont,
		});

		nodes.add({
			id: linkInId,
			label: inLabel,
			x: midX,
			y: midY,
			color: linkNodeColor,
			font: linkNodeFont,
		});

		// Force a render pass so bounding boxes are available
		this.network.redraw();

		// Get actual node widths from bounding boxes and reposition with consistent gap
		let outHalfWidth = 100;
		let inHalfWidth = 100;
		try {
			const outBox = this.network.getBoundingBox(linkOutId);
			if (outBox) {
				outHalfWidth = (outBox.right - outBox.left) / 2;
			}
			const inBox = this.network.getBoundingBox(linkInId);
			if (inBox) {
				inHalfWidth = (inBox.right - inBox.left) / 2;
			}
		} catch (e) {
			// getBoundingBox may fail if node hasn't rendered yet; use defaults
		}

		nodes.update({
			id: linkOutId,
			x: midX - outHalfWidth,
			y: midY,
		});
		nodes.update({
			id: linkInId,
			x: midX + inHalfWidth,
			y: midY,
		});

		// Remove original edge
		edges.remove(originalEdgeData.id);

		// Edge label from original
		const edgeLabel = originalEdgeData.label || "";

		// Add link edges
		edges.add({
			id: outEdgeId,
			from: fromVisId,
			to: linkOutId,
			label: edgeLabel,
			color: {
				color: "rgba(50, 160, 160, 0.8)",
				highlight: "rgba(80, 190, 190, 1)",
			},
			font: {
				color: "rgba(238, 238, 238, 1)",
			},
		} as any);

		edges.add({
			id: inEdgeId,
			from: linkInId,
			to: toVisId,
			label: edgeLabel,
			color: {
				color: "rgba(50, 160, 160, 0.8)",
				highlight: "rgba(80, 190, 190, 1)",
			},
			font: {
				color: "rgba(238, 238, 238, 1)",
			},
		} as any);

		const pair: ILinkPair = {
			linkOutId: linkOutId,
			linkInId: linkInId,
			outEdgeId: outEdgeId,
			inEdgeId: inEdgeId,
			originalEdgeData: originalEdgeData,
			descriptor: descriptor,
			amount: itemAmount,
		};

		this.linkPairs.push(pair);
		return pair;
	}

	// ==================== Combined Link Methods ====================

	/**
	 * Count the effective number of edges per item for split eligibility,
	 * treating edges that belong to the same combined link group as a single edge.
	 */
	private countEffectiveEdgesPerItem(graphEdges: any[]): {
		[item: string]: number;
	} {
		const effectiveCount: { [item: string]: number } = {};
		const countedCombinedGroups = new Set<ICombinedLinkGroup>();

		for (const e of graphEdges) {
			const edgeFromKey = getNodeKey(e.from);
			const edgeToKey = getNodeKey(e.to);
			const edgeItem = e.itemAmount.item;

			// Check if this edge is part of a combined link group
			const combinedGroup = this.combinedLinkGroups.find((g) =>
				g.originalPairs.some(
					(p) =>
						p.descriptor.fromNodeKey === edgeFromKey &&
						p.descriptor.toNodeKey === edgeToKey &&
						p.descriptor.itemClassName === edgeItem,
				),
			);

			if (combinedGroup) {
				if (!countedCombinedGroups.has(combinedGroup)) {
					// First edge from this combined group — count as 1
					countedCombinedGroups.add(combinedGroup);
					effectiveCount[edgeItem] = (effectiveCount[edgeItem] || 0) + 1;
				}
				// else: already counted this combined group, skip
			} else {
				// Not part of any combined group — count individually
				effectiveCount[edgeItem] = (effectiveCount[edgeItem] || 0) + 1;
			}
		}

		return effectiveCount;
	}

	/**
	 * Check whether a set of link pairs contains at least one combinable group
	 * (2+ pairs sharing the same item and destination key).
	 */
	private hasCombinableGroups(pairs: ILinkPair[]): boolean {
		if (pairs.length < 2) {
			return false;
		}
		// Check for groups sharing same item + toNodeKey (multiple sources → one dest)
		const toCounts: { [key: string]: number } = {};
		// Check for groups sharing same item + fromNodeKey (one source → multiple dests)
		const fromCounts: { [key: string]: number } = {};
		for (const pair of pairs) {
			const toKey =
				pair.descriptor.itemClassName + "||to||" + pair.descriptor.toNodeKey;
			toCounts[toKey] = (toCounts[toKey] || 0) + 1;
			const fromKey =
				pair.descriptor.itemClassName +
				"||from||" +
				pair.descriptor.fromNodeKey;
			fromCounts[fromKey] = (fromCounts[fromKey] || 0) + 1;
		}
		for (const key in toCounts) {
			if (toCounts.hasOwnProperty(key) && toCounts[key] >= 2) {
				return true;
			}
		}
		for (const key in fromCounts) {
			if (fromCounts.hasOwnProperty(key) && fromCounts[key] >= 2) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get combined link groups whose nodes are among the selected node IDs.
	 */
	private getSelectedCombinedGroups(
		selectedNodeIds: number[],
	): ICombinedLinkGroup[] {
		const groups = new Set<ICombinedLinkGroup>();
		for (const nodeId of selectedNodeIds) {
			const group = this.combinedLinkGroups.find(
				(g) => g.combinedOutId === nodeId || g.combinedInId === nodeId,
			);
			if (group) {
				groups.add(group);
			}
		}
		return Array.from(groups);
	}

	/**
	 * Check whether the current selection (regular link pairs + combined link groups)
	 * can be combined into a (larger) combined group.
	 * Requires at least 2 distinct sources (individual pairs or combined groups).
	 */
  private canCombineSelection(selectedNodeIds: number[]): boolean {
    // ALL selected nodes must be link or combined-link nodes
    for (const nodeId of selectedNodeIds) {
      const isLinkNode = this.linkPairs.some(
        (p) => p.linkOutId === nodeId || p.linkInId === nodeId,
      );
      const isCombinedLinkNode = this.combinedLinkGroups.some(
        (g) => g.combinedOutId === nodeId || g.combinedInId === nodeId,
      );
      if (!isLinkNode && !isCombinedLinkNode) {
        return false;
      }
    }

    const regularPairs = this.getSelectedLinkPairs(selectedNodeIds);
    const combinedGroups = this.getSelectedCombinedGroups(selectedNodeIds);

    // Need at least 2 separate sources (distinct pairs or groups)
    const sourceCount = regularPairs.length + combinedGroups.length;
    if (sourceCount < 2) {
      return false;
    }

		// Collect all descriptors (regular pairs + original pairs from combined groups)
		const allDescriptors: ILinkNodeDescriptor[] = [];
		for (const pair of regularPairs) {
			allDescriptors.push(pair.descriptor);
		}
		for (const group of combinedGroups) {
			for (const origPair of group.originalPairs) {
				allDescriptors.push(origPair.descriptor);
			}
		}

		if (allDescriptors.length < 2) {
			return false;
		}

		const toCounts: { [key: string]: number } = {};
		const fromCounts: { [key: string]: number } = {};
		for (const desc of allDescriptors) {
			const toKey = desc.itemClassName + "||to||" + desc.toNodeKey;
			toCounts[toKey] = (toCounts[toKey] || 0) + 1;
			const fromKey = desc.itemClassName + "||from||" + desc.fromNodeKey;
			fromCounts[fromKey] = (fromCounts[fromKey] || 0) + 1;
		}
		for (const key in toCounts) {
			if (toCounts.hasOwnProperty(key) && toCounts[key] >= 2) {
				return true;
			}
		}
		for (const key in fromCounts) {
			if (fromCounts.hasOwnProperty(key) && fromCounts[key] >= 2) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get unique link pairs corresponding to the selected node IDs.
	 */
	private getSelectedLinkPairs(selectedNodeIds: number[]): ILinkPair[] {
		const pairSet = new Set<ILinkPair>();
		for (const nodeId of selectedNodeIds) {
			const pair = this.linkPairs.find(
				(p) => p.linkOutId === nodeId || p.linkInId === nodeId,
			);
			if (pair) {
				pairSet.add(pair);
			}
		}
		return Array.from(pairSet);
	}

	private handleCombineLinks(
		selectedNodeIds: number[],
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
		const selectedPairs = this.getSelectedLinkPairs(selectedNodeIds);
		const selectedCombinedGroups =
			this.getSelectedCombinedGroups(selectedNodeIds);

		// If no combined groups are involved, just combine the regular pairs
		if (selectedCombinedGroups.length === 0) {
			if (selectedPairs.length >= 2) {
				this.tryCombinePairs(selectedPairs, nodes, edges, result);
			}
			return;
		}

		// Collect all original descriptors from selected regular pairs and combined groups
		// so we can find them again after uncombining
		const allDescriptors: ILinkNodeDescriptor[] = [];
		for (const pair of selectedPairs) {
			allDescriptors.push({ ...pair.descriptor });
		}
		for (const group of selectedCombinedGroups) {
			for (const origPair of group.originalPairs) {
				allDescriptors.push({ ...origPair.descriptor });
			}
		}

		// Uncombine selected combined groups (process in reverse index order to avoid shifting)
		const groupIndices = selectedCombinedGroups
			.map((g) => this.combinedLinkGroups.indexOf(g))
			.filter((i) => i !== -1)
			.sort((a, b) => b - a);

		for (const idx of groupIndices) {
			this.uncombineCombinedGroup(idx, nodes, edges, result);
		}

		// Now find all matching pairs in this.linkPairs using the collected descriptors
		const allPairs: ILinkPair[] = [];
		for (const desc of allDescriptors) {
			const pair = this.linkPairs.find(
				(p) =>
					p.descriptor.fromNodeKey === desc.fromNodeKey &&
					p.descriptor.toNodeKey === desc.toNodeKey &&
					p.descriptor.itemClassName === desc.itemClassName,
			);
			if (pair && allPairs.indexOf(pair) === -1) {
				allPairs.push(pair);
			}
		}

		if (allPairs.length >= 2) {
			this.tryCombinePairs(allPairs, nodes, edges, result);
		}
	}

	private tryCombinePairs(
		pairs: ILinkPair[],
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
		// Group by item and destination key (toNodeKey) — "out" type: multiple sources → one dest
		const toGroups: { [key: string]: ILinkPair[] } = {};
		// Group by item and source key (fromNodeKey) — "in" type: one source → multiple dests
		const fromGroups: { [key: string]: ILinkPair[] } = {};

		for (const pair of pairs) {
			const toKey =
				pair.descriptor.itemClassName + "||" + pair.descriptor.toNodeKey;
			if (!toGroups[toKey]) {
				toGroups[toKey] = [];
			}
			toGroups[toKey].push(pair);

			const fromKey =
				pair.descriptor.itemClassName + "||" + pair.descriptor.fromNodeKey;
			if (!fromGroups[fromKey]) {
				fromGroups[fromKey] = [];
			}
			fromGroups[fromKey].push(pair);
		}

		// Prefer whichever grouping yields a combinable group; try "out" first
		const combined = new Set<ILinkPair>();

		for (const key in toGroups) {
			if (toGroups.hasOwnProperty(key) && toGroups[key].length >= 2) {
				const groupPairs = toGroups[key].filter((p) => !combined.has(p));
				if (groupPairs.length >= 2) {
					this.combineLinksGroup(groupPairs, "out", nodes, edges, result);
					for (const p of groupPairs) {
						combined.add(p);
					}
				}
			}
		}

		for (const key in fromGroups) {
			if (fromGroups.hasOwnProperty(key) && fromGroups[key].length >= 2) {
				const groupPairs = fromGroups[key].filter((p) => !combined.has(p));
				if (groupPairs.length >= 2) {
					this.combineLinksGroup(groupPairs, "in", nodes, edges, result);
					for (const p of groupPairs) {
						combined.add(p);
					}
				}
			}
		}
	}

	private combineLinksGroup(
		pairs: ILinkPair[],
		type: "out" | "in",
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
		const itemClassName = pairs[0].descriptor.itemClassName;
		const itemName = model.getItem(itemClassName).prototype.name;
		const sourceKey =
			type === "out"
				? pairs[0].descriptor.toNodeKey
				: pairs[0].descriptor.fromNodeKey;

		// Gather edge data from each pair before removal
		const pairEdgeData: {
			fromVisId: number;
			toVisId: number;
			outLabel: string;
			inLabel: string;
			amount: number;
		}[] = [];
		let totalAmount = 0;

		for (const pair of pairs) {
			const outEdge = edges.get(pair.outEdgeId) as any;
			const inEdge = edges.get(pair.inEdgeId) as any;
			if (!outEdge || !inEdge) {
				continue;
			}

			const fromVisId = outEdge.from;
			const toVisId = inEdge.to;

			// Get amount: prefer stored pair.amount (handles split-edge links with scaled amounts),
			// fall back to graph edge lookup for backward compatibility
			let amount = 0;
			if (pair.amount != null) {
				amount = pair.amount;
			} else {
				const graphEdge = result.graph.edges.find((e) => {
					return (
						getNodeKey(e.from) === pair.descriptor.fromNodeKey &&
						getNodeKey(e.to) === pair.descriptor.toNodeKey &&
						e.itemAmount.item === pair.descriptor.itemClassName
					);
				});
				if (graphEdge) {
					amount = graphEdge.itemAmount.amount;
				}
			}
			totalAmount += amount;

			pairEdgeData.push({
				fromVisId: fromVisId,
				toVisId: toVisId,
				outLabel: outEdge.label || "",
				inLabel: inEdge.label || "",
				amount: amount,
			});
		}

		if (pairEdgeData.length < 2) {
			return;
		}

		// Get position of first pair's relevant node for placement
		const firstPair = pairs[0];
		const posData = this.network.getPositions([
			firstPair.linkOutId,
			firstPair.linkInId,
		]);
		const combinedOutPos = posData[firstPair.linkOutId] || { x: 0, y: 0 };
		const combinedInPos = posData[firstPair.linkInId] || { x: 0, y: 0 };

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

		// Deduplicate source and target vis IDs for edge creation (handles split scenarios)
		const sourceAmounts = new Map<number, number>();
		for (const data of pairEdgeData) {
			sourceAmounts.set(
				data.fromVisId,
				(sourceAmounts.get(data.fromVisId) || 0) + data.amount,
			);
		}
		const targetAmounts = new Map<number, number>();
		for (const data of pairEdgeData) {
			targetAmounts.set(
				data.toVisId,
				(targetAmounts.get(data.toVisId) || 0) + data.amount,
			);
		}
		const uniqueSources = sourceAmounts.size;
		const uniqueTargets = targetAmounts.size;

		// Determine labels
		const amountStr = Strings.formatItemAmount(totalAmount, itemClassName);
		let sourceName: string;

		// Find the source display name from graph nodes
		const sourceGraphNode = result.graph.nodes.find(
			(n) => getNodeKey(n) === sourceKey,
		);
		sourceName = sourceGraphNode
			? getNodeDisplayName(sourceGraphNode)
			: sourceKey;

		let outLabel: string;
		let inLabel: string;

		if (type === "out") {
			const toStr =
				uniqueTargets === 1
					? sourceName
					: sourceName + " (" + uniqueTargets + " splits)";
			outLabel =
				"<b>Link Out: " +
				itemName +
				"</b>\n<i>To: " +
				toStr +
				"</i>\n" +
				amountStr;
			inLabel =
				"<b>Link In: " +
				itemName +
				"</b>\n<i>From: (" +
				uniqueSources +
				" sources)</i>\n" +
				amountStr;
		} else {
			const fromStr =
				uniqueSources === 1
					? sourceName
					: sourceName + " (" + uniqueSources + " splits)";
			outLabel =
				"<b>Link Out: " +
				itemName +
				"</b>\n<i>To: (" +
				uniqueTargets +
				" destinations)</i>\n" +
				amountStr;
			inLabel =
				"<b>Link In: " +
				itemName +
				"</b>\n<i>From: " +
				fromStr +
				"</i>\n" +
				amountStr;
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
				border: "rgba(0, 0, 0, 0)",
				background: "rgba(50, 160, 160, 1)",
				highlight: {
					border: "rgba(238, 238, 238, 1)",
					background: "rgba(80, 190, 190, 1)",
				},
			},
			font: {
				color: "rgba(238, 238, 238, 1)",
			},
		});

		nodes.add({
			id: combinedInId,
			label: inLabel,
			x: combinedInPos.x,
			y: combinedInPos.y,
			color: {
				border: "rgba(0, 0, 0, 0)",
				background: "rgba(50, 160, 160, 1)",
				highlight: {
					border: "rgba(238, 238, 238, 1)",
					background: "rgba(80, 190, 190, 1)",
				},
			},
			font: {
				color: "rgba(238, 238, 238, 1)",
			},
		});

		const linkEdgeColor = {
			color: "rgba(50, 160, 160, 0.8)",
			highlight: "rgba(80, 190, 190, 1)",
		};
		const linkEdgeFont = {
			color: "rgba(238, 238, 238, 1)",
		};

		// Source edges: one per unique source vis ID (deduplicated for split scenarios)
		sourceAmounts.forEach((srcAmount, srcId) => {
			const edgeId = this.combinedEdgeIdCounter++;
			combinedEdgeIds.push(edgeId);
			edges.add({
				id: edgeId,
				from: srcId,
				to: combinedOutId,
				label:
					itemName + "\n" + Strings.formatItemAmount(srcAmount, itemClassName),
				color: linkEdgeColor,
				font: linkEdgeFont,
			} as any);
		});
		// Target edges: one per unique target vis ID (deduplicated for split scenarios)
		targetAmounts.forEach((tgtAmount, tgtId) => {
			const edgeId = this.combinedEdgeIdCounter++;
			combinedEdgeIds.push(edgeId);
			edges.add({
				id: edgeId,
				from: combinedInId,
				to: tgtId,
				label:
					itemName + "\n" + Strings.formatItemAmount(tgtAmount, itemClassName),
				color: linkEdgeColor,
				font: linkEdgeFont,
			} as any);
		});

		const descriptor: ICombinedLinkDescriptor = {
			type: type,
			itemClassName: itemClassName,
			sourceKey: sourceKey,
			originalDescriptors: removedPairs.map((p) => ({ ...p.descriptor })),
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

	private uncombineCombinedGroup(
		groupIndex: number,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
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
				return (
					getNodeKey(e.from) === desc.fromNodeKey &&
					getNodeKey(e.to) === desc.toNodeKey &&
					e.itemAmount.item === desc.itemClassName
				);
			});

			if (!graphEdge) {
				// Restore original edge data if possible
				if (originalPair.originalEdgeData) {
					edges.add(originalPair.originalEdgeData);
				}
				continue;
			}

			// Handle split-edge links: the original recipe node doesn't exist in the vis DataSet,
			// so we need to find the split node and the vis edge connecting it.
			if (desc.splitRecipeKey != null && desc.splitNodeIndex != null) {
				// Restore the split edge into the DataSet first — it was consumed by createLinkPair
				// when the link was originally created, and combineLinksGroup didn't restore it.
				// applyStoredSplitEdgeLink expects to find the split edge in the DataSet.
				if (originalPair.originalEdgeData) {
					edges.add(originalPair.originalEdgeData);
				}
				const applied = this.applyStoredSplitEdgeLink(
					desc,
					graphEdge,
					nodes,
					edges,
					result,
					originalPair.amount,
				);
				if (!applied) {
					// applyStoredSplitEdgeLink failed; the edge we just restored stays as-is
				}
				continue;
			}

			const positions = this.network.getPositions([
				graphEdge.from.id,
				graphEdge.to.id,
			]);
			const fromPos = positions[graphEdge.from.id] || { x: 0, y: 0 };
			const toPos = positions[graphEdge.to.id] || { x: 0, y: 0 };

			// The original edge was already removed from the vis DataSet; we need to recreate it
			// but createLinkPair expects it in the edges DataSet. Add it temporarily.
			edges.add(originalPair.originalEdgeData);

			const newPair = this.createLinkPair(
				nodes,
				edges,
				graphEdge.from.id,
				graphEdge.to.id,
				originalPair.originalEdgeData,
				desc,
				graphEdge.itemAmount.item,
				graphEdge.itemAmount.amount,
				fromPos,
				toPos,
				getNodeDisplayName(graphEdge.from),
				getNodeDisplayName(graphEdge.to),
			);

			// Restore saved positions if available
			if (desc.linkOutPos) {
				nodes.update({
					id: newPair.linkOutId,
					x: desc.linkOutPos.x,
					y: desc.linkOutPos.y,
				});
			}
			if (desc.linkInPos) {
				nodes.update({
					id: newPair.linkInId,
					x: desc.linkInPos.x,
					y: desc.linkInPos.y,
				});
			}
		}

		// Remove from tracking
		this.combinedLinkGroups.splice(groupIndex, 1);

		this.saveCombinedLinks();
		this.saveLinkNodes();
		this.saveNodePositions();
	}

	private applyStoredCombinedLinks(
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
		const descriptors = this.loadCombinedLinks();
		if (descriptors.length === 0) {
			return;
		}

		const appliedDescriptors: ICombinedLinkDescriptor[] = [];

		for (const descriptor of descriptors) {
			// Find the link pairs that match the original descriptors
			const matchingPairs: ILinkPair[] = [];

			for (const origDesc of descriptor.originalDescriptors) {
				const pair = this.linkPairs.find(
					(p) =>
						p.descriptor.fromNodeKey === origDesc.fromNodeKey &&
						p.descriptor.toNodeKey === origDesc.toNodeKey &&
						p.descriptor.itemClassName === origDesc.itemClassName,
				);
				if (pair) {
					matchingPairs.push(pair);
				}
			}

			if (matchingPairs.length < 2) {
				continue;
			}

			// Combine them
			this.combineLinksGroup(
				matchingPairs,
				descriptor.type,
				nodes,
				edges,
				result,
			);

			// Restore saved positions for the combined nodes
			const group = this.combinedLinkGroups[this.combinedLinkGroups.length - 1];
			if (group) {
				if (descriptor.combinedOutPos) {
					nodes.update({
						id: group.combinedOutId,
						x: descriptor.combinedOutPos.x,
						y: descriptor.combinedOutPos.y,
					});
				}
				if (descriptor.combinedInPos) {
					nodes.update({
						id: group.combinedInId,
						x: descriptor.combinedInPos.x,
						y: descriptor.combinedInPos.y,
					});
				}
			}

			appliedDescriptors.push(descriptor);
		}

		if (appliedDescriptors.length !== descriptors.length) {
			this.saveCombinedLinksFromDescriptors(appliedDescriptors);
		}
	}

	// ==================== Combined Link Persistence ====================

	private saveCombinedLinks(): void {
		if (this.network) {
			for (const group of this.combinedLinkGroups) {
				const pos = this.network.getPositions([
					group.combinedOutId,
					group.combinedInId,
				]);
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

	private saveCombinedLinksFromDescriptors(
		descriptors: ICombinedLinkDescriptor[],
	): void {
		try {
			let allCombined: { [key: string]: ICombinedLinkDescriptor[] } = {};
			const existing = localStorage.getItem(
				CustomGraphComponentController.COMBINED_LINKS_STORAGE_KEY,
			);
			if (existing) {
				allCombined = JSON.parse(existing);
			}
			allCombined[this.tabId] = descriptors;
			localStorage.setItem(
				CustomGraphComponentController.COMBINED_LINKS_STORAGE_KEY,
				JSON.stringify(allCombined),
			);
		} catch (e) {
			// ignore
		}
	}

	private loadCombinedLinks(): ICombinedLinkDescriptor[] {
		try {
			const stored = localStorage.getItem(
				CustomGraphComponentController.COMBINED_LINKS_STORAGE_KEY,
			);
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

	private applyStoredLinks(
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		savedPositions: { [key: string]: { x: number; y: number } },
	): void {
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
				return (
					getNodeKey(e.from) === descriptor.fromNodeKey &&
					getNodeKey(e.to) === descriptor.toNodeKey &&
					e.itemAmount.item === descriptor.itemClassName
				);
			});

			if (!graphEdge) {
				continue;
			}

			// Handle split-edge links: the original graph edge won't exist in the vis DataSet,
			// but a corresponding split edge will exist connecting to a split node
			if (
				descriptor.splitRecipeKey != null &&
				descriptor.splitNodeIndex != null
			) {
				const applied = this.applyStoredSplitEdgeLink(
					descriptor,
					graphEdge,
					nodes,
					edges,
					result,
				);
				if (applied) {
					appliedDescriptors.push(descriptor);
				}
				continue;
			}

			// Check edge still exists in vis DataSet
			const visEdge = edges.get(graphEdge.id);
			if (!visEdge) {
				continue;
			}

			// Get positions of from/to nodes
			const positions = this.network.getPositions([
				graphEdge.from.id,
				graphEdge.to.id,
			]);
			const fromPos = positions[graphEdge.from.id];
			const toPos = positions[graphEdge.to.id];
			if (!fromPos || !toPos) {
				continue;
			}

			const pair = this.createLinkPair(
				nodes,
				edges,
				graphEdge.from.id,
				graphEdge.to.id,
				visEdge,
				descriptor,
				graphEdge.itemAmount.item,
				graphEdge.itemAmount.amount,
				fromPos,
				toPos,
				getNodeDisplayName(graphEdge.from),
				getNodeDisplayName(graphEdge.to),
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

	private applyStoredSplitEdgeLink(
		descriptor: ILinkNodeDescriptor,
		graphEdge: any,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		overrideAmount?: number,
	): boolean {
		// Find the split group by recipe key
		const splitGroup = this.splitGroups.find(
			(g) => g.descriptor.recipeNodeKey === descriptor.splitRecipeKey,
		);
		if (!splitGroup) {
			return false;
		}

		// Get the split node at the specified index
		const splitNodeIndex = descriptor.splitNodeIndex!;
		if (
			splitNodeIndex < 0 ||
			splitNodeIndex >= splitGroup.splitNodeIds.length
		) {
			return false;
		}
		const splitNodeId = splitGroup.splitNodeIds[splitNodeIndex];

		// Determine which side the recipe (split) node is on
		const isSplitFrom = descriptor.fromNodeKey === descriptor.splitRecipeKey;

		// Find the other endpoint (the non-split graph node)
		const otherKey = isSplitFrom
			? descriptor.toNodeKey
			: descriptor.fromNodeKey;
		const otherGraphNode = result.graph.nodes.find(
			(n) => getNodeKey(n) === otherKey,
		);
		if (!otherGraphNode) {
			return false;
		}

// Resolve the actual vis node ID for the other endpoint (may be a split node
// from another split group when both endpoints are split)
let otherVisNodeId = otherGraphNode.id;
if (descriptor.otherSplitRecipeKey != null && descriptor.otherSplitNodeIndex != null) {
const otherSplitGrp = this.splitGroups.find(
(g) => g.descriptor.recipeNodeKey === descriptor.otherSplitRecipeKey,
);
if (otherSplitGrp && descriptor.otherSplitNodeIndex! < otherSplitGrp.splitNodeIds.length) {
otherVisNodeId = otherSplitGrp.splitNodeIds[descriptor.otherSplitNodeIndex!];
}
}

// Find the vis edge connecting the split node to/from the other node
const itemName = model.getItem(descriptor.itemClassName).prototype.name;
const matchingEdges = edges.get().filter((e: any) => {
if (isSplitFrom) {
return e.from === splitNodeId && e.to === otherVisNodeId;
} else {
return e.from === otherVisNodeId && e.to === splitNodeId;
}
});

		// Disambiguate by item name from label if multiple matches
		let visEdge: any = null;
		if (matchingEdges.length === 1) {
			visEdge = matchingEdges[0];
		} else if (matchingEdges.length > 1) {
			visEdge =
				matchingEdges.find((e: any) => {
					const labelFirstLine = ((e.label || "") as string)
						.split("\n")[0]
						.trim();
					return labelFirstLine === itemName;
				}) || matchingEdges[0];
		}

		if (!visEdge) {
			return false;
		}

		// Check this edge is actually a split edge
		if (splitGroup.splitEdgeIds.indexOf(visEdge.id) === -1) {
			return false;
		}

		// Compute the correct amount for this split edge.
		// Use overrideAmount if provided (from uncombine), otherwise:
		// Primary edges (split-item edges in the split direction) keep their original
		// per-edge amount. Non-primary edges (shared/duplicated edges) must be scaled
		// by the split fraction.
		let linkAmount = graphEdge.itemAmount.amount;
		if (overrideAmount != null) {
			linkAmount = overrideAmount;
		} else {
			const splitItemClassName = splitGroup.descriptor.splitItemClassName;
			if (splitItemClassName) {
				const isOutputSplit = splitGroup.descriptor.splitType === "output";
				const isPrimaryEdge =
					graphEdge.itemAmount.item === splitItemClassName &&
					(isOutputSplit
						? graphEdge.from.id === splitGroup.originalNodeId
						: graphEdge.to.id === splitGroup.originalNodeId);

				if (!isPrimaryEdge) {
					const splitItemEdges = result.graph.edges.filter(
						(e) =>
							(isOutputSplit ? e.from.id : e.to.id) ===
								splitGroup.originalNodeId &&
							e.itemAmount.item === splitItemClassName,
					);
					const totalSplitAmount = splitItemEdges.reduce(
						(sum, e) => sum + e.itemAmount.amount,
						0,
					);
					if (totalSplitAmount > 0 && splitNodeIndex < splitItemEdges.length) {
						const fraction =
							splitItemEdges[splitNodeIndex].itemAmount.amount /
							totalSplitAmount;
						linkAmount = graphEdge.itemAmount.amount * fraction;
					}
				}
			}
		}

// Get positions
const fromNodeId = isSplitFrom ? splitNodeId : otherVisNodeId;
const toNodeId = isSplitFrom ? otherVisNodeId : splitNodeId;
		const positions = this.network.getPositions([fromNodeId, toNodeId]);
		const fromPos = positions[fromNodeId];
		const toPos = positions[toNodeId];
		if (!fromPos || !toPos) {
			return false;
		}

// Determine display names
const otherVisNodeData = nodes.get(otherVisNodeId);
const otherName = (otherVisNodeId !== otherGraphNode.id && otherVisNodeData)
? ((otherVisNodeData.label || "") as string)
.replace(/<[^>]*>/g, "")
.split("\n")[0]
.trim() || getNodeDisplayName(otherGraphNode)
: getNodeDisplayName(otherGraphNode);
const splitNodeData = nodes.get(splitNodeId);
const splitName = splitNodeData
? ((splitNodeData.label || "") as string)
.replace(/<[^>]*>/g, "")
.split("\n")[0]
.trim() || "Split Node"
: "Split Node";

const fromDisplayName = isSplitFrom ? splitName : otherName;
const toDisplayName = isSplitFrom ? otherName : splitName;

const pair = this.createLinkPair(
nodes,
edges,
fromNodeId,
toNodeId,
visEdge,
descriptor,
graphEdge.itemAmount.item,
linkAmount,
fromPos,
toPos,
fromDisplayName,
toDisplayName,
);

		// Restore saved positions for link nodes
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

		return true;
	}

	// ==================== Split Node Methods ====================

	private splitRecipeByOutput(
		nodeId: number,
		recipeNode: RecipeNode,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		itemToSplit?: string,
	): void {
		this.splitRecipeByDirection(
			nodeId,
			recipeNode,
			nodes,
			edges,
			result,
			"output",
			itemToSplit,
		);
	}

	private splitRecipeByInput(
		nodeId: number,
		recipeNode: RecipeNode,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		itemToSplit?: string,
	): void {
		this.splitRecipeByDirection(
			nodeId,
			recipeNode,
			nodes,
			edges,
			result,
			"input",
			itemToSplit,
		);
	}

	private splitRecipeByDirection(
		nodeId: number,
		recipeNode: RecipeNode,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		splitType: "output" | "input",
		itemToSplit?: string,
	): void {
		const isOutput = splitType === "output";

		// Find edges along the split direction (output = from this node, input = to this node)
		const allDirectionalEdges = result.graph.edges.filter(
			(e) => (isOutput ? e.from.id : e.to.id) === nodeId,
		);

		// Determine which item to split on
		if (!itemToSplit) {
			const itemEdgeCount: { [item: string]: number } = {};
			for (const e of allDirectionalEdges) {
				itemEdgeCount[e.itemAmount.item] =
					(itemEdgeCount[e.itemAmount.item] || 0) + 1;
			}
			const candidates = Object.keys(itemEdgeCount).filter(
				(item) => itemEdgeCount[item] >= 2,
			);
			if (candidates.length === 0) {
				return;
			}
			itemToSplit = candidates[0];
		}

		// Filter to only edges carrying the split item
		const splitEdges = allDirectionalEdges.filter(
			(e) => e.itemAmount.item === itemToSplit,
		);
		if (splitEdges.length <= 1) {
			return;
		}

		// Check this node isn't already part of a split group
		if (this.splitGroups.some((g) => g.originalNodeId === nodeId)) {
			return;
		}

		// Before gathering vis edges, restore any link pairs (and combined link groups)
		// connected to this recipe node back to original edges. Link pairs replace the
		// original vis edges with link nodes/edges, which breaks split logic because:
		// 1) Link edge IDs don't match graph edge IDs, so scaling lookups fail.
		// 2) Original vis edges used to identify primary split edges are missing.
		const recipeKey = getNodeKey(recipeNode);

		// First, uncombine any combined link groups that involve this recipe node.
		// Save their info so we can re-combine after the split without duplicating.
		const removedCombinedGroupInfos: {
			type: "out" | "in";
			combinedOutPos?: { x: number; y: number };
			combinedInPos?: { x: number; y: number };
			descriptors: ILinkNodeDescriptor[];
		}[] = [];
		for (let i = this.combinedLinkGroups.length - 1; i >= 0; i--) {
			const group = this.combinedLinkGroups[i];
			const involvesRecipe = group.originalPairs.some(
				(p) =>
					p.descriptor.fromNodeKey === recipeKey ||
					p.descriptor.toNodeKey === recipeKey,
			);
			if (involvesRecipe) {
				const cgPos = this.network.getPositions([
					group.combinedOutId,
					group.combinedInId,
				]);
				removedCombinedGroupInfos.push({
					type: group.type,
					combinedOutPos: cgPos[group.combinedOutId],
					combinedInPos: cgPos[group.combinedInId],
					descriptors: group.originalPairs.map((p) => ({ ...p.descriptor })),
				});
				this.uncombineCombinedGroup(i, nodes, edges, result);
			}
		}

		// Then, remove any link pairs connected to this recipe node, saving their info for recreation
		interface IRemovedLinkInfo {
			descriptor: ILinkNodeDescriptor;
			linkOutPos?: { x: number; y: number };
			linkInPos?: { x: number; y: number };
			combinedGroupIndex?: number;
		}
		const removedLinkInfos: IRemovedLinkInfo[] = [];

		for (let i = this.linkPairs.length - 1; i >= 0; i--) {
			const pair = this.linkPairs[i];
			if (
				pair.descriptor.fromNodeKey === recipeKey ||
				pair.descriptor.toNodeKey === recipeKey
			) {
				// Save info for recreation after split
				const linkPositions = this.network.getPositions([
					pair.linkOutId,
					pair.linkInId,
				]);

				// Check if this pair was part of a combined group that we just uncombined
				let cgIdx: number | undefined;
				for (let ci = 0; ci < removedCombinedGroupInfos.length; ci++) {
					if (
						removedCombinedGroupInfos[ci].descriptors.some(
							(d) =>
								d.fromNodeKey === pair.descriptor.fromNodeKey &&
								d.toNodeKey === pair.descriptor.toNodeKey &&
								d.itemClassName === pair.descriptor.itemClassName,
						)
					) {
						cgIdx = ci;
						break;
					}
				}

				removedLinkInfos.push({
					descriptor: { ...pair.descriptor },
					linkOutPos: linkPositions[pair.linkOutId],
					linkInPos: linkPositions[pair.linkInId],
					combinedGroupIndex: cgIdx,
				});

				edges.remove(pair.outEdgeId);
				edges.remove(pair.inEdgeId);
				nodes.remove(pair.linkOutId);
				nodes.remove(pair.linkInId);
				edges.add(pair.originalEdgeData);
				this.linkPairs.splice(i, 1);
			}
		}

		// Gather all vis edges connected to this node
		const allVisEdges = this.getVisEdgesForNode(nodeId, edges);

    // Resolve all vis edges to their corresponding graph edges.
    // This handles vis edges that are split edges from other split groups
    // (whose IDs don't match any graph edge ID directly).
    type VisEdgeResolution = {
      visEdge: any;
      graphEdge: any;
      splitGroup: ISplitGroup | null;
      splitNodeIndex: number;
    };

    const splitItemGraphEdgeIds = new Set(splitEdges.map((e) => e.id));
    const visEdgeResolutions: VisEdgeResolution[] = [];
    for (const visEdge of allVisEdges) {
      const resolved = this.resolveVisEdgeToGraphEdge(
        visEdge,
        nodeId,
        result,
      );
      if (resolved) {
        visEdgeResolutions.push({
          visEdge,
          graphEdge: resolved.graphEdge,
          splitGroup: resolved.splitGroup,
          splitNodeIndex: resolved.splitNodeIndex,
        });
      }
    }

    // Group resolved vis edges by their graph edge ID
    const graphEdgeGroupMap = new Map<number, VisEdgeResolution[]>();
    for (const res of visEdgeResolutions) {
      const geId = res.graphEdge.id as number;
      if (!graphEdgeGroupMap.has(geId)) {
        graphEdgeGroupMap.set(geId, []);
      }
      graphEdgeGroupMap.get(geId)!.push(res);
    }

    // Categorize graph edge groups into: primary, other same-direction, opposite-direction
    type GraphEdgeGroup = {
      graphEdge: any;
      resolutions: VisEdgeResolution[];
    };
    const primaryGroups: GraphEdgeGroup[] = [];
    const otherSameDirGroups: GraphEdgeGroup[] = [];
    const oppositeDirGroups: GraphEdgeGroup[] = [];

    graphEdgeGroupMap.forEach((resolutions, geId) => {
      const graphEdge = resolutions[0].graphEdge;
      const isSplitDir = isOutput
        ? graphEdge.from.id === nodeId
        : graphEdge.to.id === nodeId;

      const group: GraphEdgeGroup = { graphEdge, resolutions };
      if (isSplitDir && splitItemGraphEdgeIds.has(geId)) {
        primaryGroups.push(group);
      } else if (isSplitDir) {
        otherSameDirGroups.push(group);
      } else {
        oppositeDirGroups.push(group);
      }
    });

		// Save original node data
		const originalNodeData = nodes.get(nodeId);
		if (!originalNodeData) {
			return;
		}

		const originalEdgesData = allVisEdges.map((e: any) => ({ ...e }));

		// Get original node position
		const positions = this.network.getPositions([nodeId]);
		const originalPos = positions[nodeId] || { x: 0, y: 0 };

		const descriptor: ISplitDescriptor = {
			recipeNodeKey: recipeKey,
			splitType: splitType,
			splitItemClassName: itemToSplit,
		};

		const splitNodeIds: number[] = [];
		const splitEdgeIds: number[] = [];

    // Calculate total amount across the split item's edges
    const totalAmount = splitEdges.reduce(
      (sum, e) => sum + e.itemAmount.amount,
      0,
    );

    // Expand primary groups into individual split entries when the other end
    // is itself split. Each vis edge connecting to a different split node of
    // another split group gets its own split entry (and thus its own split node).
    const splitEntries: {
      graphEdge: any;
      resolutions: VisEdgeResolution[];
      amount: number;
      otherSplitGroup: ISplitGroup | null;
      otherSplitNodeIndex: number;
    }[] = [];

    for (const primaryGroup of primaryGroups) {
      const splitResolutions = primaryGroup.resolutions.filter(
        (r) => r.splitGroup !== null,
      );

      if (
        splitResolutions.length > 0 &&
        splitResolutions.length === primaryGroup.resolutions.length
      ) {
        // All resolutions connect to split nodes of another group —
        // expand each into its own split entry
        for (const res of splitResolutions) {
          const otherFraction = this.getSplitNodeFraction(
            res.splitGroup!,
            res.splitNodeIndex,
            result,
          );
          splitEntries.push({
            graphEdge: primaryGroup.graphEdge,
            resolutions: [res],
            amount:
              primaryGroup.graphEdge.itemAmount.amount * otherFraction,
            otherSplitGroup: res.splitGroup,
            otherSplitNodeIndex: res.splitNodeIndex,
          });
        }
      } else {
        // Normal case: one entry per primary group
        splitEntries.push({
          graphEdge: primaryGroup.graphEdge,
          resolutions: primaryGroup.resolutions,
          amount: primaryGroup.graphEdge.itemAmount.amount,
          otherSplitGroup: null,
          otherSplitNodeIndex: -1,
        });
      }
    }

    // Remove all edges connected to the original node
    for (const visEdge of allVisEdges) {
      edges.remove(visEdge.id);
    }
    // Remove the original node
    nodes.remove(nodeId);

    // Create one split node per split entry
    const splitFractions: number[] = [];
    for (let i = 0; i < splitEntries.length; i++) {
      const entry = splitEntries[i];
      const splitNodeId = this.splitNodeIdCounter++;
      splitNodeIds.push(splitNodeId);

      const offsetY = (i - (splitEntries.length - 1) / 2) * 120;

      // Calculate proportional machine amount based on entry flow amount
      const graphEdge = entry.graphEdge;
      const fraction =
        totalAmount > 0
          ? entry.amount / totalAmount
          : 1 / splitEntries.length;
      splitFractions.push(fraction);
      const splitAmount = recipeNode.recipeData.amount * fraction;

      // Create split node with label and tooltip
      const splitLabel =
        "<b>Split " +
        recipeNode.recipeData.recipe.name +
        "</b>\n" +
        Strings.formatNumber(splitAmount) +
        "x " +
        recipeNode.recipeData.machine.name +
        "\n<i>" +
        recipeNode.recipeData.clockSpeed +
        "% clock speed</i>";

      const titleEl = this.buildSplitNodeTooltip(recipeNode, splitAmount);

      nodes.add({
        id: splitNodeId,
        label: splitLabel,
        title: titleEl as unknown as string,
        x: originalPos.x,
        y: originalPos.y + offsetY,
        color: {
          border: "rgba(0, 0, 0, 0)",
          background: "rgba(180, 85, 20, 1)",
          highlight: {
            border: "rgba(238, 238, 238, 1)",
            background: "rgba(195, 100, 35, 1)",
          },
        },
        font: {
          color: "rgba(238, 238, 238, 1)",
        },
      });

      // Create primary edges for vis edges in this entry
      for (const res of entry.resolutions) {
        const primaryEdge = res.visEdge;
        const splitPrimaryEdgeId = this.splitEdgeIdCounter++;
        splitEdgeIds.push(splitPrimaryEdgeId);
        edges.add({
          id: splitPrimaryEdgeId,
          from: isOutput ? splitNodeId : primaryEdge.from,
          to: isOutput ? primaryEdge.to : splitNodeId,
          label: primaryEdge.label || "",
          color: primaryEdge.color || {
            color: "rgba(105, 125, 145, 1)",
            highlight: "rgba(134, 151, 167, 1)",
          },
          font: primaryEdge.font || {
            color: "rgba(238, 238, 238, 1)",
          },
          smooth: primaryEdge.smooth,
        } as any);
      }

      // Duplicate opposite-direction edges to this split node (with scaled amounts)
      for (const oppGroup of oppositeDirGroups) {
        for (const res of oppGroup.resolutions) {
          const edgeId = this.splitEdgeIdCounter++;
          splitEdgeIds.push(edgeId);
          // For split-group vis edges, apply the other split's fraction as base multiplier
          let baseMultiplier: number | undefined;
          if (res.splitGroup) {
            baseMultiplier = this.getSplitNodeFraction(
              res.splitGroup,
              res.splitNodeIndex,
              result,
            );
          }
          edges.add(
            this.buildScaledSplitEdge(
              edgeId,
              res.visEdge,
              splitNodeId,
              fraction,
              result,
              !isOutput,
              res.graphEdge,
              baseMultiplier,
            ),
          );
        }
      }

      // Duplicate other same-direction edges from this split node (with scaled amounts)
      for (const otherGroup of otherSameDirGroups) {
        for (const res of otherGroup.resolutions) {
          const edgeId = this.splitEdgeIdCounter++;
          splitEdgeIds.push(edgeId);
          let baseMultiplier: number | undefined;
          if (res.splitGroup) {
            baseMultiplier = this.getSplitNodeFraction(
              res.splitGroup,
              res.splitNodeIndex,
              result,
            );
          }
          edges.add(
            this.buildScaledSplitEdge(
              edgeId,
              res.visEdge,
              splitNodeId,
              fraction,
              result,
              isOutput,
              res.graphEdge,
              baseMultiplier,
            ),
          );
        }
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

		// Recreate link pairs on split edges for previously-linked edges
		if (removedLinkInfos.length > 0) {
      this.recreateLinksOnSplitEdges(
        removedLinkInfos,
        group,
        splitFractions,
        splitEntries.map((e) => ({
          graphEdge: e.graphEdge,
          otherSplitGroup: e.otherSplitGroup,
          otherSplitNodeIndex: e.otherSplitNodeIndex,
        })),
        itemToSplit!,
				isOutput,
				nodes,
				edges,
				result,
				recipeKey,
				removedCombinedGroupInfos,
			);
		}

		this.saveSplitNodes();
		this.saveLinkNodes();
		this.saveCombinedLinks();
		this.saveNodePositions();
	}

	/**
	 * After splitting a recipe, recreate any link pairs that existed on the original
	 * recipe's edges onto the resulting split edges. Non-primary links (not on the
	 * split item or in the opposite direction) get individual link pairs per split
	 * node and are auto-combined into a single link-out/link-in node pair.
	 */
private recreateLinksOnSplitEdges(
removedLinkInfos: {
descriptor: ILinkNodeDescriptor;
linkOutPos?: { x: number; y: number };
linkInPos?: { x: number; y: number };
combinedGroupIndex?: number;
}[],
group: ISplitGroup,
splitFractions: number[],
    splitNodeInfos: {
      graphEdge: any;
      otherSplitGroup: ISplitGroup | null;
      otherSplitNodeIndex: number;
    }[],
    splitItem: string,
    isOutput: boolean,
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
		recipeKey: string,
		removedCombinedGroupInfos: {
			type: "out" | "in";
			combinedOutPos?: { x: number; y: number };
			combinedInPos?: { x: number; y: number };
			descriptors: ILinkNodeDescriptor[];
		}[],
	): void {
		// Map from combinedGroupIndex to all recreated pairs for that group
		const combinedGroupPairsMap = new Map<number, ILinkPair[]>();

		for (const info of removedLinkInfos) {
			const isFromRecipe = info.descriptor.fromNodeKey === recipeKey;
			const isInSplitDirection = isOutput ? isFromRecipe : !isFromRecipe;
			const isOnSplitItem = info.descriptor.itemClassName === splitItem;

			const otherKey = isFromRecipe
				? info.descriptor.toNodeKey
				: info.descriptor.fromNodeKey;
			const otherGraphNode = result.graph.nodes.find(
				(n) => getNodeKey(n) === otherKey,
			);
			if (!otherGraphNode) {
				continue;
			}

			const graphEdge = result.graph.edges.find(
				(e) =>
					getNodeKey(e.from) === info.descriptor.fromNodeKey &&
					getNodeKey(e.to) === info.descriptor.toNodeKey &&
					e.itemAmount.item === info.descriptor.itemClassName,
			);
			if (!graphEdge) {
				continue;
			}

			const recreatedPairs: ILinkPair[] = [];

			for (let si = 0; si < group.splitNodeIds.length; si++) {
				const splitNodeId = group.splitNodeIds[si];

// For primary-direction split-item links, only the matching split node applies
if (isInSplitDirection && isOnSplitItem) {
// Check if this split node's primary edge connects to the right target
              const nodeInfo = splitNodeInfos[si];
              const pe = nodeInfo.graphEdge;
              const peTarget = isOutput ? pe.to.id : pe.from.id;
if (peTarget !== otherGraphNode.id) {
continue;
}
// If both this split node and the link target connect to specific
// split nodes of another group, ensure they match
if (nodeInfo.otherSplitGroup && info.descriptor.splitRecipeKey) {
if (
nodeInfo.otherSplitGroup.descriptor.recipeNodeKey === info.descriptor.splitRecipeKey &&
nodeInfo.otherSplitNodeIndex !== info.descriptor.splitNodeIndex
) {
continue;
}
}
}

const fraction = splitFractions[si];

// Resolve the actual vis node ID for the "other" endpoint.
// If the link references a split of the other endpoint, use the specific split node ID.
let resolvedOtherVisId = otherGraphNode.id;
if (info.descriptor.splitRecipeKey != null && info.descriptor.splitNodeIndex != null) {
const otherSplitGrp = this.splitGroups.find(
(g) => g.descriptor.recipeNodeKey === info.descriptor.splitRecipeKey,
);
if (otherSplitGrp && info.descriptor.splitNodeIndex! < otherSplitGrp.splitNodeIds.length) {
resolvedOtherVisId = otherSplitGrp.splitNodeIds[info.descriptor.splitNodeIndex!];
}
}

// Primary edges (split-item in split direction) carry the entry's primary amount;
// non-primary edges are scaled by the split fraction.
const scaledAmount =
isInSplitDirection && isOnSplitItem
? splitNodeInfos[si].graphEdge.itemAmount.amount *
(splitNodeInfos[si].otherSplitGroup
? this.getSplitNodeFraction(splitNodeInfos[si].otherSplitGroup!, splitNodeInfos[si].otherSplitNodeIndex, result)
: 1)
: graphEdge.itemAmount.amount * fraction;

// Find the split edge connecting this split node to/from the other node
const splitEdge = this.findSplitEdgeForLink(
splitNodeId,
resolvedOtherVisId,
isFromRecipe,
info.descriptor.itemClassName,
group,
edges,
);
				if (!splitEdge) {
					continue;
				}

const fromId = isFromRecipe ? splitNodeId : resolvedOtherVisId;
const toId = isFromRecipe ? resolvedOtherVisId : splitNodeId;
const posMap = this.network.getPositions([fromId, toId]);
const fromPos = posMap[fromId] || { x: 0, y: 0 };
const toPos = posMap[toId] || { x: 0, y: 0 };

const splitNodeData = nodes.get(splitNodeId);
const splitName = splitNodeData
? ((splitNodeData.label || "") as string)
.replace(/<[^>]*>/g, "")
.split("\n")[0]
.trim() || "Split Node"
: "Split Node";
// Get display name for the other node (may be a split node itself)
const otherNodeData = nodes.get(resolvedOtherVisId);
const otherName = (resolvedOtherVisId !== otherGraphNode.id && otherNodeData)
? ((otherNodeData.label || "") as string)
.replace(/<[^>]*>/g, "")
.split("\n")[0]
.trim() || getNodeDisplayName(otherGraphNode)
: getNodeDisplayName(otherGraphNode);

const newDesc: ILinkNodeDescriptor = {
fromNodeKey: info.descriptor.fromNodeKey,
toNodeKey: info.descriptor.toNodeKey,
itemClassName: info.descriptor.itemClassName,
splitRecipeKey: recipeKey,
splitNodeIndex: si,
};
// Track the other endpoint's split info for cross-split persistence
if (info.descriptor.splitRecipeKey != null) {
newDesc.otherSplitRecipeKey = info.descriptor.splitRecipeKey;
newDesc.otherSplitNodeIndex = info.descriptor.splitNodeIndex;
} else if (splitNodeInfos[si].otherSplitGroup) {
newDesc.otherSplitRecipeKey = splitNodeInfos[si].otherSplitGroup!.descriptor.recipeNodeKey;
newDesc.otherSplitNodeIndex = splitNodeInfos[si].otherSplitNodeIndex;
}

const pair = this.createLinkPair(
nodes,
edges,
fromId,
toId,
splitEdge,
newDesc,
info.descriptor.itemClassName,
scaledAmount,
fromPos,
toPos,
isFromRecipe ? splitName : otherName,
isFromRecipe ? otherName : splitName,
);

				recreatedPairs.push(pair);
			}

			if (info.combinedGroupIndex != null) {
				// Collect pairs for combined group — will be combined together at the end
				const existing =
					combinedGroupPairsMap.get(info.combinedGroupIndex) || [];
				existing.push(...recreatedPairs);
				combinedGroupPairsMap.set(info.combinedGroupIndex, existing);
			} else {
				// Individual link pair (not from a combined group) — handle as before
				if (recreatedPairs.length >= 2) {
					// Auto-combine: output links → "out" type (multiple split sources → one dest),
					// input links → "in" type (one source → multiple split destinations)
					const combineType: "out" | "in" = isFromRecipe ? "out" : "in";
					this.combineLinksGroup(
						recreatedPairs,
						combineType,
						nodes,
						edges,
						result,
					);

					// Restore original link positions on the combined nodes
					const lastGroup =
						this.combinedLinkGroups[this.combinedLinkGroups.length - 1];
					if (lastGroup && info.linkOutPos) {
						nodes.update({
							id: lastGroup.combinedOutId,
							x: info.linkOutPos.x,
							y: info.linkOutPos.y,
						});
					}
					if (lastGroup && info.linkInPos) {
						nodes.update({
							id: lastGroup.combinedInId,
							x: info.linkInPos.x,
							y: info.linkInPos.y,
						});
					}
				} else if (recreatedPairs.length === 1) {
					// Single link pair — restore positions
					if (info.linkOutPos) {
						nodes.update({
							id: recreatedPairs[0].linkOutId,
							x: info.linkOutPos.x,
							y: info.linkOutPos.y,
						});
					}
					if (info.linkInPos) {
						nodes.update({
							id: recreatedPairs[0].linkInId,
							x: info.linkInPos.x,
							y: info.linkInPos.y,
						});
					}
				}
			}
		}

		// Combine all pairs from each original combined group together (prevents duplication)
		combinedGroupPairsMap.forEach((pairs, cgIndex) => {
			if (pairs.length >= 2) {
				const cgInfo = removedCombinedGroupInfos[cgIndex];
				this.combineLinksGroup(pairs, cgInfo.type, nodes, edges, result);

				// Restore original combined link positions
				const lastGroup =
					this.combinedLinkGroups[this.combinedLinkGroups.length - 1];
				if (lastGroup && cgInfo.combinedOutPos) {
					nodes.update({
						id: lastGroup.combinedOutId,
						x: cgInfo.combinedOutPos.x,
						y: cgInfo.combinedOutPos.y,
					});
				}
				if (lastGroup && cgInfo.combinedInPos) {
					nodes.update({
						id: lastGroup.combinedInId,
						x: cgInfo.combinedInPos.x,
						y: cgInfo.combinedInPos.y,
					});
				}
			} else if (pairs.length === 1) {
				// Single pair from a combined group — just leave as individual link pair
				const info = removedLinkInfos.find(
					(i) => i.combinedGroupIndex === cgIndex,
				);
				if (info && info.linkOutPos) {
					nodes.update({
						id: pairs[0].linkOutId,
						x: info.linkOutPos.x,
						y: info.linkOutPos.y,
					});
				}
				if (info && info.linkInPos) {
					nodes.update({
						id: pairs[0].linkInId,
						x: info.linkInPos.x,
						y: info.linkInPos.y,
					});
				}
			}
		});
	}

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
	): any | null {
		const matchingSplitEdges = group.splitEdgeIds
			.map((eid) => edges.get(eid) as any)
			.filter((e: any) => e != null)
			.filter((e: any) => {
				if (isFromRecipe) {
					return e.from === splitNodeId && e.to === otherNodeId;
				} else {
					return e.from === otherNodeId && e.to === splitNodeId;
				}
			});

		if (matchingSplitEdges.length === 1) {
			return matchingSplitEdges[0];
		}
		if (matchingSplitEdges.length > 1) {
			const itemName = model.getItem(itemClassName).prototype.name;
			return (
				matchingSplitEdges.find((e: any) => {
					const label = ((e.label || "") as string).split("\n")[0].trim();
					return label === itemName;
				}) || matchingSplitEdges[0]
			);
		}
		return null;
	}

	/**
	 * Build hover tooltip element for a split node, matching RecipeNode.getTooltip() format.
	 */
	private buildSplitNodeTooltip(
		recipeNode: RecipeNode,
		splitAmount: number,
	): HTMLElement {
		const splitRecipeData = new RecipeData(
			recipeNode.recipeData.machine,
			recipeNode.recipeData.recipe,
			splitAmount,
			recipeNode.recipeData.clockSpeed,
		);
		const splitMachineGroup = new MachineGroup(splitRecipeData);
		const splitMultiplier =
			splitAmount *
			recipeNode.recipeData.machine.metadata.manufacturingSpeed *
			(recipeNode.recipeData.clockSpeed / 100) *
			(60 / recipeNode.recipeData.recipe.time);

		const titleLines: string[] = [];
		for (const machine of splitMachineGroup.machines) {
			titleLines.push(
				machine.amount +
					"x " +
					recipeNode.recipeData.machine.name +
					" at <b>" +
					machine.clockSpeed +
					"%</b> clock speed",
			);
		}
		titleLines.push("");
		titleLines.push(
			"Needed power: " + Numbers.round(splitMachineGroup.power.average) + " MW",
		);
		titleLines.push("");
		for (const ingredient of recipeNode.recipeData.recipe.ingredients) {
			const item = model.getItem(ingredient.item);
			titleLines.push(
				"<b>IN:</b> " +
					Strings.formatItemAmount(
						ingredient.amount * splitMultiplier,
						ingredient.item,
					) +
					" - " +
					item.prototype.name,
			);
		}
		for (const product of recipeNode.recipeData.recipe.products) {
			const item = model.getItem(product.item);
			titleLines.push(
				"<b>OUT:</b> " +
					Strings.formatItemAmount(
						product.amount * splitMultiplier,
						product.item,
					) +
					" - " +
					item.prototype.name,
			);
		}
		const titleEl = document.createElement("div");
		titleEl.innerHTML = titleLines.join("<br>");
		return titleEl;
	}

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
  ): any {
    const graphEdge =
      resolvedGraphEdge ||
      result.graph.edges.find((e) => e.id === originalVisEdge.id);
    let scaledLabel = originalVisEdge.label || "";
    if (graphEdge) {
      const baseAmount =
        graphEdge.itemAmount.amount * (baseAmountMultiplier ?? 1);
      const scaledAmount = baseAmount * fraction;
			scaledLabel =
				model.getItem(graphEdge.itemAmount.item).prototype.name +
				"\n" +
				Strings.formatItemAmount(scaledAmount, graphEdge.itemAmount.item);
		}
		return {
			id: edgeId,
			from: splitNodeIsFrom ? splitNodeId : originalVisEdge.from,
			to: splitNodeIsFrom ? originalVisEdge.to : splitNodeId,
			label: scaledLabel,
			color: originalVisEdge.color || {
				color: "rgba(105, 125, 145, 1)",
				highlight: "rgba(134, 151, 167, 1)",
			},
			font: originalVisEdge.font || {
				color: "rgba(238, 238, 238, 1)",
			},
      smooth: originalVisEdge.smooth,
    };
  }

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
  } | null {
    // Direct match by edge ID
    const directMatch = result.graph.edges.find((e) => e.id === visEdge.id);
    if (directMatch) {
      return { graphEdge: directMatch, splitGroup: null, splitNodeIndex: -1 };
    }

    // Check if this vis edge belongs to another split group
    for (const sg of this.splitGroups) {
      if (sg.originalNodeId === nodeId) {
        continue;
      }
      if (sg.splitEdgeIds.indexOf(visEdge.id) === -1) {
        continue;
      }

      const visFrom = visEdge.from as number;
      const visTo = visEdge.to as number;

      // Find which split node this edge connects to
      let splitNodeId: number | null = null;
      let splitNodeIndex = -1;
      for (let si = 0; si < sg.splitNodeIds.length; si++) {
        if (
          sg.splitNodeIds[si] === visFrom ||
          sg.splitNodeIds[si] === visTo
        ) {
          splitNodeId = sg.splitNodeIds[si];
          splitNodeIndex = si;
          break;
        }
      }
      if (splitNodeId === null) {
        continue;
      }

      // Reconstruct original graph endpoints by substituting split node with original
      const graphFrom =
        visFrom === splitNodeId ? sg.originalNodeId : visFrom;
      const graphTo = visTo === splitNodeId ? sg.originalNodeId : visTo;

      // Match by endpoints and item name from the vis edge label
      const itemName = ((visEdge.label || "") as string)
        .split("\n")[0]
        .trim();
      const graphEdge = result.graph.edges.find(
        (e) =>
          e.from.id === graphFrom &&
          e.to.id === graphTo &&
          model.getItem(e.itemAmount.item).prototype.name === itemName,
      );

      if (graphEdge) {
        return { graphEdge, splitGroup: sg, splitNodeIndex };
      }
      break;
    }

    return null;
  }

  /**
   * Compute the split fraction that a specific split node represents
   * within its split group.
   */
  private getSplitNodeFraction(
    sg: ISplitGroup,
    splitNodeIndex: number,
    result: ProductionResult,
  ): number {
    const splitItemClassName = sg.descriptor.splitItemClassName;
    if (!splitItemClassName) {
      return 1;
    }

    const isOutputSplit = sg.descriptor.splitType === "output";
    const splitItemEdges = result.graph.edges.filter(
      (e) =>
        (isOutputSplit ? e.from.id : e.to.id) === sg.originalNodeId &&
        e.itemAmount.item === splitItemClassName,
    );

    const totalSplitAmount = splitItemEdges.reduce(
      (sum, e) => sum + e.itemAmount.amount,
      0,
    );
    if (totalSplitAmount <= 0 || splitNodeIndex >= splitItemEdges.length) {
      return 1;
    }

    return (
      splitItemEdges[splitNodeIndex].itemAmount.amount / totalSplitAmount
    );
  }

  private combineSplitGroup(
groupIndex: number,
nodes: DataSet<IVisNode>,
edges: DataSet<IVisEdge>,
): void {
let group = this.splitGroups[groupIndex];
const recombiningRecipeKey = group.descriptor.recipeNodeKey;

// Detect other split groups that have edges connecting to this group's split nodes.
// These "dependent" groups were expanded due to cross-split with this group and
// need to be recombined first (while our split nodes still exist) then re-split after.
const dependentGroupInfos: {
recipeKey: string;
splitType: "output" | "input";
splitItemClassName?: string;
splitNodePositions?: { [index: string]: { x: number; y: number } };
}[] = [];

for (const otherGroup of this.splitGroups) {
if (otherGroup === group) continue;
// Check if any of otherGroup's split edges connect to one of our split nodes
const hasConnection = otherGroup.splitEdgeIds.some((eid) => {
const edge = edges.get(eid) as any;
if (!edge) return false;
return (
group.splitNodeIds.indexOf(edge.from as number) !== -1 ||
group.splitNodeIds.indexOf(edge.to as number) !== -1
);
});
if (hasConnection) {
// Save positions of the dependent split nodes before recombining
const depPos: { [index: string]: { x: number; y: number } } = {};
if (this.network) {
const pos = this.network.getPositions(otherGroup.splitNodeIds);
for (let i = 0; i < otherGroup.splitNodeIds.length; i++) {
if (pos[otherGroup.splitNodeIds[i]]) {
depPos[i.toString()] = pos[otherGroup.splitNodeIds[i]];
}
}
}
dependentGroupInfos.push({
recipeKey: otherGroup.descriptor.recipeNodeKey,
splitType: otherGroup.descriptor.splitType,
splitItemClassName: otherGroup.descriptor.splitItemClassName,
splitNodePositions: depPos,
});
}
}

// Recombine dependent groups first (while our split nodes still exist)
for (const depInfo of dependentGroupInfos) {
const depIdx = this.splitGroups.findIndex(
(g) => g.descriptor.recipeNodeKey === depInfo.recipeKey,
);
if (depIdx !== -1) {
this.combineSplitGroup(depIdx, nodes, edges);
}
}

// Re-find our group index (may have shifted due to dependent recombines)
groupIndex = this.splitGroups.findIndex(
(g) => g.descriptor.recipeNodeKey === recombiningRecipeKey,
);
if (groupIndex === -1) return;
group = this.splitGroups[groupIndex];

// Remove any combined link groups that contain split-edge link pairs from this group
		for (let i = this.combinedLinkGroups.length - 1; i >= 0; i--) {
			const cg = this.combinedLinkGroups[i];
			const hasSplitPairs = cg.originalPairs.some(
				(p) => p.descriptor.splitRecipeKey === group.descriptor.recipeNodeKey,
			);
			if (hasSplitPairs) {
				for (const edgeId of cg.combinedEdgeIds) {
					edges.remove(edgeId);
				}
				nodes.remove(cg.combinedOutId);
				nodes.remove(cg.combinedInId);
				this.combinedLinkGroups.splice(i, 1);
			}
		}

		// Remove any link pairs that are attached to split nodes in this group
		// Collect descriptors of removed links so we can restore them on the original node
		const restoredLinkDescriptors: {
			descriptor: ILinkNodeDescriptor;
			linkOutPos?: { x: number; y: number };
			linkInPos?: { x: number; y: number };
		}[] = [];
		for (let i = this.linkPairs.length - 1; i >= 0; i--) {
			const pair = this.linkPairs[i];
			if (pair.descriptor.splitRecipeKey === group.descriptor.recipeNodeKey) {
				// Save link positions and descriptor for restoring after recombine
				const linkPositions = this.network.getPositions([
					pair.linkOutId,
					pair.linkInId,
				]);
restoredLinkDescriptors.push({
descriptor: {
fromNodeKey: pair.descriptor.fromNodeKey,
toNodeKey: pair.descriptor.toNodeKey,
itemClassName: pair.descriptor.itemClassName,
// If the other endpoint is also split, restore as a split-edge link
// referencing the other recipe's split group
...(pair.descriptor.otherSplitRecipeKey != null
? {
    splitRecipeKey: pair.descriptor.otherSplitRecipeKey,
    splitNodeIndex: pair.descriptor.otherSplitNodeIndex,
  }
: {}),
},
linkOutPos: linkPositions[pair.linkOutId],
linkInPos: linkPositions[pair.linkInId],
});
				// This link pair is on a split edge of this group — remove it
				edges.remove(pair.outEdgeId);
				edges.remove(pair.inEdgeId);
				nodes.remove(pair.linkOutId);
				nodes.remove(pair.linkInId);
				// Restore the original split edge so it can be cleaned up below
				edges.add(pair.originalEdgeData);
				this.linkPairs.splice(i, 1);
			}
		}

// Compute average position of all split nodes before removing them
let avgX = 0;
let avgY = 0;
let posCount = 0;
if (this.network && group.splitNodeIds.length > 0) {
const splitPositions = this.network.getPositions(group.splitNodeIds);
for (const splitNodeId of group.splitNodeIds) {
if (splitPositions[splitNodeId]) {
avgX += splitPositions[splitNodeId].x;
avgY += splitPositions[splitNodeId].y;
posCount++;
}
}
}

// Remove all split edges
for (const edgeId of group.splitEdgeIds) {
edges.remove(edgeId);
}

// Remove all split nodes
for (const nodeId of group.splitNodeIds) {
nodes.remove(nodeId);
}

// Restore original node at the average position of the split nodes
nodes.add(group.originalNodeData);
if (posCount > 0) {
nodes.update({
id: group.originalNodeData.id,
x: avgX / posCount,
y: avgY / posCount,
});
}

		// Restore original edges
		for (const edgeData of group.originalEdgesData) {
			edges.add(edgeData);
		}

		// Remove from tracking
		this.splitGroups.splice(groupIndex, 1);

// Restore link pairs that existed before the split (deduplicated by descriptor)
if (restoredLinkDescriptors.length > 0 && this.currentResult) {
const seen = new Set<string>();
for (const info of restoredLinkDescriptors) {
let key =
info.descriptor.fromNodeKey +
"||" +
info.descriptor.toNodeKey +
"||" +
info.descriptor.itemClassName;
// Include split info in dedup key so cross-split links targeting different
// split nodes of the other group are not incorrectly merged
if (info.descriptor.splitRecipeKey) {
key += "||" + info.descriptor.splitRecipeKey + "||" + info.descriptor.splitNodeIndex;
}
if (seen.has(key)) {
continue;
}
seen.add(key);

const graphEdge = this.currentResult.graph.edges.find(
(e) =>
getNodeKey(e.from) === info.descriptor.fromNodeKey &&
getNodeKey(e.to) === info.descriptor.toNodeKey &&
e.itemAmount.item === info.descriptor.itemClassName,
);
if (!graphEdge) {
continue;
}

// If the restored descriptor references a split edge (other endpoint still split),
// use applyStoredSplitEdgeLink which handles resolving split node endpoints
if (info.descriptor.splitRecipeKey != null && info.descriptor.splitNodeIndex != null) {
info.descriptor.linkOutPos = info.linkOutPos;
info.descriptor.linkInPos = info.linkInPos;
this.applyStoredSplitEdgeLink(info.descriptor, graphEdge, nodes, edges, this.currentResult!);
continue;
}

const visEdge = edges.get(graphEdge.id);
if (!visEdge) {
continue;
}

const positions = this.network.getPositions([
graphEdge.from.id,
graphEdge.to.id,
]);
const fromPos = positions[graphEdge.from.id];
const toPos = positions[graphEdge.to.id];
if (!fromPos || !toPos) {
continue;
}

const pair = this.createLinkPair(
nodes,
edges,
graphEdge.from.id,
graphEdge.to.id,
visEdge,
info.descriptor,
graphEdge.itemAmount.item,
graphEdge.itemAmount.amount,
fromPos,
toPos,
getNodeDisplayName(graphEdge.from),
getNodeDisplayName(graphEdge.to),
);

if (info.linkOutPos) {
nodes.update({
id: pair.linkOutId,
x: info.linkOutPos.x,
y: info.linkOutPos.y,
});
}
if (info.linkInPos) {
nodes.update({
id: pair.linkInId,
x: info.linkInPos.x,
y: info.linkInPos.y,
});
}
}
}

// Re-split dependent groups with updated edge topology (now that our node is recombined)
if (dependentGroupInfos.length > 0 && this.currentResult) {
for (const depInfo of dependentGroupInfos) {
const graphNode = this.currentResult.graph.nodes.find(
(n) => getNodeKey(n) === depInfo.recipeKey,
);
if (!graphNode || !(graphNode instanceof RecipeNode)) continue;
// Check the node still exists in vis DataSet (not already re-split)
if (!nodes.get(graphNode.id)) continue;
const targetItem = depInfo.splitItemClassName;
if (!targetItem) continue;
// Check there are still enough edges to justify a split
const dirEdges = this.currentResult.graph.edges.filter((e) =>
depInfo.splitType === "output"
? e.from.id === graphNode.id && e.itemAmount.item === targetItem
: e.to.id === graphNode.id && e.itemAmount.item === targetItem,
);
if (dirEdges.length < 2) continue;
this.splitRecipeByDirection(
graphNode.id,
graphNode,
nodes,
edges,
this.currentResult,
depInfo.splitType,
targetItem,
);
}
}

this.saveSplitNodes();
this.saveLinkNodes();
this.saveCombinedLinks();
this.saveNodePositions();
}

private getVisEdgesForNode(nodeId: number, edges: DataSet<IVisEdge>): any[] {
		return edges.get().filter((e: any) => e.from === nodeId || e.to === nodeId);
	}

	private applyStoredSplits(
		nodes: DataSet<IVisNode>,
		edges: DataSet<IVisEdge>,
		result: ProductionResult,
	): void {
		const descriptors = this.loadSplitNodes();
		if (descriptors.length === 0) {
			return;
		}

		const appliedDescriptors: ISplitDescriptor[] = [];

		for (const descriptor of descriptors) {
			// Find the matching recipe node by key
			const graphNode = result.graph.nodes.find(
				(n) => getNodeKey(n) === descriptor.recipeNodeKey,
			);
			if (!graphNode || !(graphNode instanceof RecipeNode)) {
				continue;
			}

			// Check the node still exists in the vis DataSet (not already split)
			const visNode = nodes.get(graphNode.id);
			if (!visNode) {
				continue;
			}

			// Apply the split
			if (descriptor.splitType === "output") {
				const splitItem = descriptor.splitItemClassName;
				const outputEdges = result.graph.edges.filter(
					(e) => e.from.id === graphNode.id,
				);
				// Filter to the specific item if stored, otherwise find any duplicated item
				let targetItem = splitItem;
				if (!targetItem) {
					const itemEdgeCount: { [item: string]: number } = {};
					for (const e of outputEdges) {
						itemEdgeCount[e.itemAmount.item] =
							(itemEdgeCount[e.itemAmount.item] || 0) + 1;
					}
					const candidates = Object.keys(itemEdgeCount).filter(
						(item) => itemEdgeCount[item] >= 2,
					);
					if (candidates.length === 0) {
						continue;
					}
					targetItem = candidates[0];
				}
				const matchingEdges = outputEdges.filter(
					(e) => e.itemAmount.item === targetItem,
				);
				if (matchingEdges.length <= 1) {
					continue;
				}
				this.splitRecipeByOutput(
					graphNode.id,
					graphNode,
					nodes,
					edges,
					result,
					targetItem,
				);
			} else {
				const splitItem = descriptor.splitItemClassName;
				const inputEdges = result.graph.edges.filter(
					(e) => e.to.id === graphNode.id,
				);
				// Filter to the specific item if stored, otherwise find any duplicated item
				let targetItem = splitItem;
				if (!targetItem) {
					const itemEdgeCount: { [item: string]: number } = {};
					for (const e of inputEdges) {
						itemEdgeCount[e.itemAmount.item] =
							(itemEdgeCount[e.itemAmount.item] || 0) + 1;
					}
					const candidates = Object.keys(itemEdgeCount).filter(
						(item) => itemEdgeCount[item] >= 2,
					);
					if (candidates.length === 0) {
						continue;
					}
					targetItem = candidates[0];
				}
				const matchingEdges = inputEdges.filter(
					(e) => e.itemAmount.item === targetItem,
				);
				if (matchingEdges.length <= 1) {
					continue;
				}
				this.splitRecipeByInput(
					graphNode.id,
					graphNode,
					nodes,
					edges,
					result,
					targetItem,
				);
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

	private saveSplitNodes(): void {
		// Capture current split node positions into descriptors before saving
		if (this.network) {
			for (const group of this.splitGroups) {
				const allSplitNodeIds = group.splitNodeIds;
				const pos = this.network.getPositions(allSplitNodeIds);
				const posMap: { [index: string]: { x: number; y: number } } = {};
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

	private saveSplitNodesFromDescriptors(descriptors: ISplitDescriptor[]): void {
		try {
			let allSplits: { [key: string]: ISplitDescriptor[] } = {};
			const existing = localStorage.getItem(
				CustomGraphComponentController.SPLIT_NODES_STORAGE_KEY,
			);
			if (existing) {
				allSplits = JSON.parse(existing);
			}
			allSplits[this.tabId] = descriptors;
			localStorage.setItem(
				CustomGraphComponentController.SPLIT_NODES_STORAGE_KEY,
				JSON.stringify(allSplits),
			);
		} catch (e) {
			// ignore
		}
	}

	private loadSplitNodes(): ISplitDescriptor[] {
		try {
			const stored = localStorage.getItem(
				CustomGraphComponentController.SPLIT_NODES_STORAGE_KEY,
			);
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

	private saveLinkNodes(): void {
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

	private saveLinkNodesFromDescriptors(
		descriptors: ILinkNodeDescriptor[],
	): void {
		try {
			let allLinks: { [key: string]: ILinkNodeDescriptor[] } = {};
			const existing = localStorage.getItem(
				CustomGraphComponentController.LINK_NODES_STORAGE_KEY,
			);
			if (existing) {
				allLinks = JSON.parse(existing);
			}
			allLinks[this.tabId] = descriptors;
			localStorage.setItem(
				CustomGraphComponentController.LINK_NODES_STORAGE_KEY,
				JSON.stringify(allLinks),
			);
		} catch (e) {
			// ignore
		}
	}

	private loadLinkNodes(): ILinkNodeDescriptor[] {
		try {
			const stored = localStorage.getItem(
				CustomGraphComponentController.LINK_NODES_STORAGE_KEY,
			);
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

	private saveLinkNodePositions(): void {
		if (!this.network || !this.tabId) {
			return;
		}
		try {
			const rawPositions = this.network.getPositions();
			const linkPositions: { [key: string]: { x: number; y: number } } = {};
			for (const pair of this.linkPairs) {
				if (rawPositions[pair.linkOutId]) {
					linkPositions[pair.linkOutId] = rawPositions[pair.linkOutId];
				}
				if (rawPositions[pair.linkInId]) {
					linkPositions[pair.linkInId] = rawPositions[pair.linkInId];
				}
			}
			let allLinkPositions: { [key: string]: any } = {};
			const existing = localStorage.getItem("customGraphLinkNodePositions");
			if (existing) {
				allLinkPositions = JSON.parse(existing);
			}
			allLinkPositions[this.tabId] = linkPositions;
			localStorage.setItem(
				"customGraphLinkNodePositions",
				JSON.stringify(allLinkPositions),
			);
		} catch (e) {
			// ignore
		}
	}

	private loadLinkNodePositions(): { [key: string]: { x: number; y: number } } {
		try {
			const stored = localStorage.getItem("customGraphLinkNodePositions");
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

	private loadFrozenState(): boolean {
		try {
			const allFrozen = localStorage.getItem(
				CustomGraphComponentController.FROZEN_STORAGE_KEY,
			);
			if (allFrozen) {
				const map = JSON.parse(allFrozen);
				return map[this.tabId] === true;
			}
		} catch (e) {
			// ignore
		}
		return false;
	}

	private saveFrozenState(): void {
		try {
			let map: { [key: string]: boolean } = {};
			const existing = localStorage.getItem(
				CustomGraphComponentController.FROZEN_STORAGE_KEY,
			);
			if (existing) {
				map = JSON.parse(existing);
			}
			map[this.tabId] = this.frozen;
			localStorage.setItem(
				CustomGraphComponentController.FROZEN_STORAGE_KEY,
				JSON.stringify(map),
			);
		} catch (e) {
			// ignore
		}
	}

	private saveNodePositions(): void {
		this.saveNodePositionsForTab(this.tabId);
	}

	private saveNodePositionsForTab(tabId: string): void {
		if (!this.network || !tabId) {
			return;
		}
		try {
			let allPositions: { [key: string]: any } = {};
			const existing = localStorage.getItem(
				CustomGraphComponentController.POSITIONS_STORAGE_KEY,
			);
			if (existing) {
				allPositions = JSON.parse(existing);
			}
			// Get all positions and filter out link node IDs (>=100000) and split node IDs (>=300000) to keep storage clean
			// Save using stable node keys instead of numeric IDs so positions survive reloads
			const rawPositions = this.network.getPositions();
			const filteredPositions: { [key: string]: { x: number; y: number } } = {};
			for (const key in rawPositions) {
				if (rawPositions.hasOwnProperty(key) && parseInt(key, 10) < 100000) {
					const nodeId = parseInt(key, 10);
					const stableKey = this.nodeIdToKeyMap[nodeId];
					if (stableKey) {
						filteredPositions[stableKey] = rawPositions[key];
					}
				}
			}
			allPositions[tabId] = filteredPositions;
			// Also save link node positions separately if links exist
			if (this.linkPairs.length > 0) {
				this.saveLinkNodePositions();
			}
			localStorage.setItem(
				CustomGraphComponentController.POSITIONS_STORAGE_KEY,
				JSON.stringify(allPositions),
			);
		} catch (e) {
			// ignore storage errors
		}
	}

	private loadNodePositions(): { [key: string]: { x: number; y: number } } {
		try {
			const stored = localStorage.getItem(
				CustomGraphComponentController.POSITIONS_STORAGE_KEY,
			);
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

	private savedPositionsMatchGraph(
		savedPositions: { [key: string]: { x: number; y: number } },
		result: ProductionResult,
	): boolean {
		if (Object.keys(savedPositions).length === 0) {
			return false;
		}
		return result.graph.nodes.every((node) => {
			const key = getNodeKey(node);
			return savedPositions[key] !== undefined;
		});
	}

	private getGraphContainer(): HTMLElement {
		if (!this.graphContainer) {
			this.graphContainer = this.$element[0].querySelector(
				".custom-graph-container",
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
				height: "800px",
				edges: {
					labelHighlightBold: false,
					font: {
						size: 14,
						multi: "html",
						strokeColor: "rgba(0, 0, 0, 0.2)",
					},
					arrows: "to",
					smooth: false,
				},
				nodes: {
					labelHighlightBold: false,
					font: {
						size: 14,
						multi: "html",
					},
					margin: {
						top: 10,
						left: 10,
						right: 10,
						bottom: 10,
					},
					shape: "box",
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
