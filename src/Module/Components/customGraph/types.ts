import { Network, DataSet } from 'vis-network';
import { IVisNode } from '@src/Tools/Production/Result/IVisNode';
import { IVisEdge } from '@src/Tools/Production/Result/IVisEdge';
import { ILinkNodeDescriptor } from '@src/Tools/Production/IProductionData';
import { ProductionResult } from '@src/Tools/Production/Result/ProductionResult';

export interface ILinkPair {
	linkOutId: number;
	linkInId: number;
	outEdgeId: number;
	inEdgeId: number;
	originalEdgeData: any;
	descriptor: ILinkNodeDescriptor;
	amount?: number;
}

export interface ISplitDescriptor {
	recipeNodeKey: string;
	splitType: 'output' | 'input';
	splitItemClassName?: string;
	splitNodePositions?: { [index: string]: { x: number; y: number } };
	parentSplitRecipeKey?: string;
	parentSplitNodeIndex?: number;
}

export interface ISplitGroup {
	originalNodeId: number;
	originalNodeData: any;
	originalEdgesData: any[];
	splitNodeIds: number[];
	splitEdgeIds: number[];
	descriptor: ISplitDescriptor;
}

export interface ICombinedLinkDescriptor {
	type: 'out' | 'in';
	itemClassName: string;
	sourceKey: string;
	originalDescriptors: ILinkNodeDescriptor[];
	combinedOutPos?: { x: number; y: number };
	combinedInPos?: { x: number; y: number };
}

export interface ICombinedLinkGroup {
	type: 'out' | 'in';
	itemClassName: string;
	sourceKey: string;
	originalPairs: ILinkPair[];
	combinedOutId: number;
	combinedInId: number;
	combinedEdgeIds: number[];
	descriptor: ICombinedLinkDescriptor;
}

export interface IGraphTabState {
	frozen: boolean;
	nodePositions: { [key: string]: { x: number; y: number } };
	linkNodeDescriptors: ILinkNodeDescriptor[];
	splitNodeDescriptors: ISplitDescriptor[];
	combinedLinkDescriptors: ICombinedLinkDescriptor[];
}

/**
 * Shared mutable state for graph operations. The controller implements
 * this interface and passes itself to operation functions.
 */
export interface ICustomGraphState {
	linkPairs: ILinkPair[];
	splitGroups: ISplitGroup[];
	combinedLinkGroups: ICombinedLinkGroup[];
	nodeIdToKeyMap: { [id: number]: string };
	network: Network;
	currentResult: ProductionResult | null;

	nextLinkNodeId(): number;
	nextLinkEdgeId(): number;
	nextSplitNodeId(): number;
	nextSplitEdgeId(): number;
	nextCombinedNodeId(): number;
	nextCombinedEdgeId(): number;

	saveGraphState(): void;
}
