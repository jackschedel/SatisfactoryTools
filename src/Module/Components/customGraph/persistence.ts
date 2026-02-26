import { Network, DataSet } from 'vis-network';
import { IVisNode } from '@src/Tools/Production/Result/IVisNode';
import { IVisEdge } from '@src/Tools/Production/Result/IVisEdge';
import { ILinkNodeDescriptor } from '@src/Tools/Production/IProductionData';
import { ProductionResult } from '@src/Tools/Production/Result/ProductionResult';
import {
	IGraphTabState,
	ICustomGraphState,
	ICombinedLinkDescriptor,
	ISplitDescriptor,
} from './types';
import { getNodeKey } from './nodeUtils';

const GRAPH_STATE_STORAGE_KEY = 'customGraphState';

export function saveGraphStateForTab(
	state: ICustomGraphState,
	tabId: string,
	frozen: boolean,
	suppressSave: boolean,
): void {
	if (suppressSave) {
		return;
	}
	if (!state.network || !tabId) {
		return;
	}
	try {
		// Capture node positions using stable keys (only real graph nodes, ID < 100000)
		const rawPositions = state.network.getPositions();
		const nodePositions: { [key: string]: { x: number; y: number } } = {};
		for (const key in rawPositions) {
			if (rawPositions.hasOwnProperty(key) && parseInt(key, 10) < 100000) {
				const nodeId = parseInt(key, 10);
				const stableKey = state.nodeIdToKeyMap[nodeId];
				if (stableKey) {
					nodePositions[stableKey] = rawPositions[key];
				}
			}
		}

		// Capture link node positions into descriptors
		for (const pair of state.linkPairs) {
			const pos = state.network.getPositions([pair.linkOutId, pair.linkInId]);
			if (pos[pair.linkOutId]) {
				pair.descriptor.linkOutPos = pos[pair.linkOutId];
			}
			if (pos[pair.linkInId]) {
				pair.descriptor.linkInPos = pos[pair.linkInId];
			}
		}

		// Capture split node positions into descriptors
		for (const group of state.splitGroups) {
			const allSplitNodeIds = group.splitNodeIds;
			const pos = state.network.getPositions(allSplitNodeIds);
			const posMap: { [index: string]: { x: number; y: number } } = {};
			for (let i = 0; i < allSplitNodeIds.length; i++) {
				if (pos[allSplitNodeIds[i]]) {
					posMap[i.toString()] = pos[allSplitNodeIds[i]];
				}
			}
			group.descriptor.splitNodePositions = posMap;
		}

		// Capture combined link positions into descriptors
		for (const group of state.combinedLinkGroups) {
			const pos = state.network.getPositions([
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

		// Build unified state
		const graphState: IGraphTabState = {
			frozen: frozen,
			nodePositions: nodePositions,
			linkNodeDescriptors: state.linkPairs.map((p) => p.descriptor),
			splitNodeDescriptors: state.splitGroups.map((g) => g.descriptor),
			combinedLinkDescriptors: state.combinedLinkGroups.map(
				(g) => g.descriptor,
			),
		};

		// Load existing states for other tabs, update this tab, and save
		let allStates: { [key: string]: IGraphTabState } = {};
		const existing = localStorage.getItem(GRAPH_STATE_STORAGE_KEY);
		if (existing) {
			allStates = JSON.parse(existing);
		}
		allStates[tabId] = graphState;
		localStorage.setItem(
			GRAPH_STATE_STORAGE_KEY,
			JSON.stringify(allStates),
		);
	} catch (e) {
		// ignore storage errors
	}
}

export function loadGraphState(tabId: string): IGraphTabState {
	try {
		const stored = localStorage.getItem(GRAPH_STATE_STORAGE_KEY);
		if (stored) {
			const allStates = JSON.parse(stored);
			if (allStates[tabId]) {
				return allStates[tabId];
			}
		}
	} catch (e) {
		// ignore
	}
	return {
		frozen: false,
		nodePositions: {},
		linkNodeDescriptors: [],
		splitNodeDescriptors: [],
		combinedLinkDescriptors: [],
	};
}

/**
 * Check whether we have ANY saved positions that match graph nodes.
 * Returns true if at least one graph node has a saved position, allowing
 * partial position restoration (nodes without saved positions keep their
 * ELK-computed positions).
 */
export function hasSavedPositionsForGraph(
	savedPositions: { [key: string]: { x: number; y: number } },
	result: ProductionResult,
): boolean {
	if (Object.keys(savedPositions).length === 0) {
		return false;
	}
	return result.graph.nodes.some((node) => {
		const key = getNodeKey(node);
		return savedPositions[key] !== undefined;
	});
}
