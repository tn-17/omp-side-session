// Opens a persisted OMP fork in a right-hand Herdr pane.
// Adapted from @pi-kaush/pi-btw-with-imports; see NOTICE.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@oh-my-pi/pi-coding-agent";

const CHILD_MARKER_TYPE = "omp-side-session-child-v1";
const LAYOUT_MARKER_TYPE = "omp-side-session-layout-v1";
const HANDOFF_INTENT_TYPE = "omp-side-session-handoff-intent-v1";
const HANDOFF_READY_TYPE = "omp-side-session-handoff-ready-v1";
const HANDOFF_IMPORTED_TYPE = "omp-side-session-handoff-imported-v1";
const HANDOFF_MESSAGE_TYPE = "omp-side-session-handoff-v1";
const HANDOFF_ID_PATTERN = /<!-- omp-side-handoff:([A-Za-z0-9-]+) -->\s*$/;
const pendingHandoffDeliveries = new WeakMap<object, Map<string, number>>();
const INTERNAL_LAUNCH_COMMAND = "/side --launch";
const INTERNAL_REOPEN_COMMAND = "/side --reopen";
const EXEC_TIMEOUT_MS = 15_000;
const START_RETRY_DELAY_MS = 100;
const START_MAX_ATTEMPTS = 30;
const LIFECYCLE_POLL_INTERVAL_MS = 2_500;
const HANDOFF_DELIVERY_CLAIM_MS = LIFECYCLE_POLL_INTERVAL_MS * 2;
const MAX_SIDE_PANES = 4;
const SINGLE_COLUMN_MAIN_RATIO = 0.6;
const TWO_COLUMN_PARENT_RATIO = 0.7;
const TWO_COLUMN_MAIN_RATIO = 4 / 7;
const PAIRED_PANE_RATIO = 0.5;
const RATIO_TOLERANCE = 0.005;
const HANDOFF_PROMPT = `Prepare a clean handoff from this side conversation for the main OMP session.

Return only a concise, self-contained result. Preserve:
- conclusions and direct answers;
- decisions and tradeoffs;
- relevant evidence and file references;
- verification performed;
- unresolved risks or questions.

Exclude exploratory chatter, discarded hypotheses, tool logs, and these instructions.`;
type ExtensionApi = ExtensionAPI;

interface SideArgumentCompletion {
	value: string;
	label: string;
	description: string;
	hint: string;
}

type CustomSessionEntry = Extract<SessionEntry, { type: "custom" }>;
type MessageSessionEntry = Extract<SessionEntry, { type: "message" }>;

export interface HerdrPaneLayout {
	area: { width: number };
	panes: Array<{ pane_id: string; rect: { x: number; width: number } }>;
}

interface BoundaryResize {
	paneId: string;
	direction: "left" | "right";
	amount: number;
	rollbackPaneId: string;
	rollbackDirection: "left" | "right";
}

interface ChildMarker {
	parentSessionId: string;
	parentPaneId: string;
	sideNumber?: number;
	prompt?: string;
}

interface SideRecord {
	sideNumber: number;
	paneId: string;
	agentName: string;
	sessionFile: string;
	title: string;
	detached?: boolean;
}

interface SideLayoutMarker {
	parentPaneId: string;
	columns: string[][];
	paneNumbers?: Record<string, number>;
	sides?: SideRecord[];
}

export interface SidePanePlacement {
	targetPaneId: string;
	direction: "right" | "down";
	ratio: number;
	columnIndex: number;
	newColumn: boolean;
	sideNumber: number;
	resize?: BoundaryResize;
}

export interface ResolvedSideLayout {
	columns: string[][];
	paneNumbers: Record<string, number>;
	livePaneCount: number;
	placement?: SidePanePlacement;
}

interface CreatedSideSession {
	sessionFile: string;
	prompt?: string;
	title: string;
}

interface LaunchResult {
	ok: boolean;
	agentName?: string;
	paneId?: string;
	agentStarted?: boolean;
	reason?: string;
	warning?: string;
	canDeleteSession?: boolean;
}

interface HandoffIntent {
	requestId: string;
	handoffPrompt: string;
	createdAt: string;
}

interface HandoffReady {
	requestId: string;
	intentEntryId: string;
	promptEntryId: string;
	answerEntryId: string;
}

interface HandoffImported {
	requestId: string;
	childSessionId: string;
	sideNumber: number;
	importedAt: string;
}
interface HandoffMessageDetails {
	requestId: string;
	childSessionId: string;
	sideNumber: number;
}

interface PendingHandoff {
	requestId: string;
	childSessionId: string;
	side: SideRecord;
	content: string;
	createdAt: string;
}
interface HandoffScanFailure {
	side: SideRecord;
	error: unknown;
}

interface PendingHandoffScan {
	pending: PendingHandoff[];
	failures: HandoffScanFailure[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function herdrBinaryPath(): string {
	const configured = process.env.HERDR_BIN_PATH;
	if (!configured) return "herdr";
	if (path.isAbsolute(configured) && !existsSync(configured)) return "herdr";
	return configured;
}

function execFailure(result: ExecResult, fallback: string): string | undefined {
	if (result.code === 0 && !result.killed) return undefined;
	const detail = `${result.stderr}\n${result.stdout}`.trim();
	return detail || fallback;
}

export function parseHerdrPaneId(stdout: string): string {
	const parsed = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
	const paneId = parsed.result?.pane?.pane_id;
	if (typeof paneId !== "string" || paneId.length === 0) {
		throw new Error("missing .result.pane.pane_id");
	}
	return paneId;
}

export function parseHerdrPaneLayout(stdout: string): HerdrPaneLayout {
	const parsed = JSON.parse(stdout) as {
		result?: {
			layout?: {
				area?: { width?: unknown };
				panes?: Array<{ pane_id?: unknown; rect?: { x?: unknown; width?: unknown } }>;
			};
		};
	};
	const layout = parsed.result?.layout;
	if (!layout || typeof layout.area?.width !== "number" || layout.area.width <= 0 || !Array.isArray(layout.panes)) {
		throw new Error("missing valid .result.layout");
	}
	const panes = layout.panes.map(pane => {
		if (
			typeof pane.pane_id !== "string" ||
			pane.pane_id.length === 0 ||
			typeof pane.rect?.x !== "number" ||
			typeof pane.rect.width !== "number" ||
			pane.rect.width <= 0
		) {
			throw new Error("invalid pane in .result.layout.panes");
		}
		return { pane_id: pane.pane_id, rect: { x: pane.rect.x, width: pane.rect.width } };
	});
	return { area: { width: layout.area.width }, panes };
}

function isSideRecord(value: unknown): value is SideRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<SideRecord>;
	return (
		typeof record.sideNumber === "number" &&
		Number.isInteger(record.sideNumber) &&
		record.sideNumber >= 1 &&
		record.sideNumber <= MAX_SIDE_PANES &&
		typeof record.paneId === "string" &&
		record.paneId.length > 0 &&
		typeof record.agentName === "string" &&
		record.agentName.length > 0 &&
		typeof record.sessionFile === "string" &&
		record.sessionFile.length > 0 &&
		typeof record.title === "string" &&
		record.title.length > 0 &&
		(record.detached === undefined || typeof record.detached === "boolean")
	);
}

function latestSideLayout(ctx: ExtensionContext, parentPaneId: string): SideLayoutMarker | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== LAYOUT_MARKER_TYPE) continue;
		const data = entry.data as Partial<SideLayoutMarker> | undefined;
		if (
			data?.parentPaneId === parentPaneId &&
			Array.isArray(data.columns) &&
			data.columns.length <= 2 &&
			data.columns.every(
				column =>
					Array.isArray(column) &&
					column.length <= 2 &&
					column.every(paneId => typeof paneId === "string" && paneId.length > 0),
			) &&
			(data.paneNumbers === undefined ||
				(typeof data.paneNumbers === "object" &&
					data.paneNumbers !== null &&
					!Array.isArray(data.paneNumbers) &&
					Object.entries(data.paneNumbers).every(
						([paneId, sideNumber]) =>
							paneId.length > 0 &&
							typeof sideNumber === "number" &&
							Number.isInteger(sideNumber) &&
							sideNumber >= 1 &&
							sideNumber <= MAX_SIDE_PANES,
					))) &&
			(data.sides === undefined ||
				(Array.isArray(data.sides) &&
					data.sides.every(isSideRecord) &&
					new Set(data.sides.map(side => side.paneId)).size === data.sides.length &&
					new Set(data.sides.map(side => side.sideNumber)).size === data.sides.length))
		) {
			return {
				parentPaneId,
				columns: data.columns.map(column => [...column]),
				paneNumbers: { ...(data.paneNumbers ?? {}) },
				sides: data.sides?.map(side => ({ ...side })) ?? [],
			};
		}
	}
	return undefined;
}

export function resolveSideLayout(
	parentPaneId: string,
	storedColumns: string[][],
	layout: HerdrPaneLayout,
	storedPaneNumbers: Record<string, number> = {},
): ResolvedSideLayout {
	const liveIds = new Set(layout.panes.map(pane => pane.pane_id));
	if (!liveIds.has(parentPaneId)) throw new Error("The main Herdr pane is no longer present.");

	const seen = new Set<string>();
	const columns = storedColumns
		.map(column =>
			column.filter(paneId => {
				if (!liveIds.has(paneId) || seen.has(paneId)) return false;
				seen.add(paneId);
				return true;
			}),
		)
		.filter(column => column.length > 0);
	if (columns.length > 2 || columns.some(column => column.length > 2)) {
		throw new Error("The stored side-pane layout exceeds its supported two-column shape.");
	}

	const paneNumbers: Record<string, number> = {};
	const usedNumbers = new Set<number>();
	for (const paneId of columns.flat()) {
		const storedNumber = storedPaneNumbers[paneId];
		if (
			storedNumber !== undefined &&
			Number.isInteger(storedNumber) &&
			storedNumber >= 1 &&
			storedNumber <= MAX_SIDE_PANES &&
			!usedNumbers.has(storedNumber)
		) {
			paneNumbers[paneId] = storedNumber;
			usedNumbers.add(storedNumber);
		}
	}
	for (const [paneId, storedNumber] of Object.entries(storedPaneNumbers)) {
		if (
			!liveIds.has(paneId) &&
			Number.isInteger(storedNumber) &&
			storedNumber >= 1 &&
			storedNumber <= MAX_SIDE_PANES &&
			!usedNumbers.has(storedNumber)
		) {
			paneNumbers[paneId] = storedNumber;
			usedNumbers.add(storedNumber);
		}
	}
	for (const paneId of columns.flat()) {
		if (paneNumbers[paneId] !== undefined) continue;
		const availableNumber = [1, 2, 3, 4].find(sideNumber => !usedNumbers.has(sideNumber));
		if (availableNumber === undefined) throw new Error("No stable side number is available.");
		paneNumbers[paneId] = availableNumber;
		usedNumbers.add(availableNumber);
	}

	const livePaneCount = columns.reduce((count, column) => count + column.length, 0);
	if (livePaneCount >= MAX_SIDE_PANES) return { columns, paneNumbers, livePaneCount };
	const sideNumber = [1, 2, 3, 4].find(candidate => !usedNumbers.has(candidate));
	if (sideNumber === undefined) throw new Error("No side number is available.");

	const incompleteColumn = columns.findIndex(column => column.length < 2);
	if (incompleteColumn !== -1) {
		const anchorPaneId = columns[incompleteColumn]?.[0];
		if (!anchorPaneId) throw new Error("The side-column anchor pane is missing.");
		const placement: SidePanePlacement = {
			targetPaneId: anchorPaneId,
			direction: "down",
			ratio: PAIRED_PANE_RATIO,
			columnIndex: incompleteColumn,
			newColumn: false,
			sideNumber,
		};
		if (columns.length === 1) {
			placement.resize = calculateBoundaryResize(layout, parentPaneId, anchorPaneId, SINGLE_COLUMN_MAIN_RATIO);
		}
		return { columns, paneNumbers, livePaneCount, placement };
	}

	if (columns.length === 0) {
		return {
			columns,
			paneNumbers,
			livePaneCount,
			placement: {
				targetPaneId: parentPaneId,
				direction: "right",
				ratio: SINGLE_COLUMN_MAIN_RATIO,
				columnIndex: 0,
				newColumn: true,
				sideNumber,
			},
		};
	}

	const anchorPaneId = columns[0]?.[0];
	if (!anchorPaneId) throw new Error("The first side-column anchor pane is missing.");
	return {
		columns,
		paneNumbers,
		livePaneCount,
		placement: {
			targetPaneId: parentPaneId,
			direction: "right",
			ratio: TWO_COLUMN_MAIN_RATIO,
			columnIndex: 1,
			newColumn: true,
			sideNumber,
			resize: calculateBoundaryResize(layout, parentPaneId, anchorPaneId, TWO_COLUMN_PARENT_RATIO),
		},
	};
}

function calculateBoundaryResize(
	layout: HerdrPaneLayout,
	mainPaneId: string,
	sidePaneId: string,
	targetMainRatio: number,
): BoundaryResize | undefined {
	const main = layout.panes.find(pane => pane.pane_id === mainPaneId)?.rect;
	const side = layout.panes.find(pane => pane.pane_id === sidePaneId)?.rect;
	if (!main || !side) throw new Error("A tracked Herdr pane is no longer present.");
	if (side.x <= main.x) throw new Error("The tracked side column is no longer right of the main pane.");
	const currentMainRatio = main.width / (main.width + side.width);
	const difference = targetMainRatio - currentMainRatio;
	if (Math.abs(difference) <= RATIO_TOLERANCE) return undefined;
	return {
		paneId: difference > 0 ? mainPaneId : sidePaneId,
		direction: difference > 0 ? "right" : "left",
		amount: Number(Math.abs(difference).toFixed(6)),
		rollbackPaneId: difference > 0 ? sidePaneId : mainPaneId,
		rollbackDirection: difference > 0 ? "left" : "right",
	};
}

function isPaneBusy(result: ExecResult): boolean {
	const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
	return text.includes("pane") && (text.includes("busy") || text.includes("shell prompt"));
}

function childMarker(ctx: ExtensionContext): ChildMarker | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== CHILD_MARKER_TYPE) continue;
		const data = entry.data as Partial<ChildMarker> | undefined;
		if (
			data &&
			typeof data.parentSessionId === "string" &&
			typeof data.parentPaneId === "string" &&
			(data.sideNumber === undefined ||
				(Number.isInteger(data.sideNumber) && data.sideNumber >= 1 && data.sideNumber <= MAX_SIDE_PANES)) &&
			(data.prompt === undefined || typeof data.prompt === "string")
		) {
			return data as ChildMarker;
		}
	}
	return undefined;
}

function settledForkLeaf(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	let boundary = ctx.sessionManager.getLeafId();
	let sawSettledAssistant = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "assistant" && entry.message.stopReason === "stop") {
			sawSettledAssistant = true;
		} else if (entry.message?.role === "user" && !sawSettledAssistant) {
			boundary = entry.parentId;
		}
	}
	return boundary;
}

function sideTitle(sideNumber: number, prompt: string | undefined): string {
	if (!prompt) return `Side ${sideNumber}`;
	const preview = prompt.replace(/\s+/g, " ").trim();
	return `Side ${sideNumber}: ${preview.slice(0, 64)}`;
}

function sideDisplayTitle(side: SideRecord): string {
	const bareTitle = `Side ${side.sideNumber}`;
	return side.title === bareTitle ? "(untitled)" : side.title.replace(/^Side \d+:\s*/, "");
}

async function createSideSession(
	pi: ExtensionApi,
	ctx: ExtensionCommandContext,
	parentPaneId: string,
	sideNumber: number,
	prompt: string | undefined,
): Promise<CreatedSideSession> {
	const forkLeaf = settledForkLeaf(ctx);
	const sourceFile = ctx.sessionManager.getSessionFile();
	if (!sourceFile || !existsSync(sourceFile) || !forkLeaf) {
		throw new Error("Main has no durable settled turn to fork");
	}

	const child = await pi.pi.SessionManager.open(sourceFile, ctx.sessionManager.getSessionDir(), undefined, {
		suppressBreadcrumb: true,
	});
	try {
		const sessionFile = child.createBranchedSession(forkLeaf);
		if (!sessionFile) throw new Error("Failed to persist the side-session fork");

		const title = sideTitle(sideNumber, prompt);
		await child.setSessionName(title, "user");
		child.appendCustomEntry(CHILD_MARKER_TYPE, {
			parentSessionId: ctx.sessionManager.getSessionId(),
			parentPaneId,
			sideNumber,
			...(prompt ? { prompt } : {}),
		} satisfies ChildMarker);
		await child.ensureOnDisk();
		await child.flush();
		await pi.pi.copySessionArtifacts(sourceFile, sessionFile);
		return { sessionFile, prompt, title };
	} finally {
		await child.close();
	}
}

async function managedSideSessionPath(ctx: ExtensionContext, sessionFile: string): Promise<string> {
	const resolved = path.resolve(sessionFile);
	const lexicalCandidateDir = path.dirname(resolved);
	const activeSessionDir = await fs.realpath(path.resolve(ctx.sessionManager.getSessionDir()));
	const candidateDir = await fs.realpath(lexicalCandidateDir);
	const managedSessionsRoot = path.dirname(activeSessionDir);
	const isActiveSessionDir = candidateDir === activeSessionDir;
	const isManagedProjectDir =
		path.basename(managedSessionsRoot) === "sessions" && path.dirname(candidateDir) === managedSessionsRoot;
	if (path.extname(resolved) !== ".jsonl" || (!isActiveSessionDir && !isManagedProjectDir)) {
		throw new Error("Refusing to delete a side session outside the managed sessions root.");
	}

	try {
		const candidate = await fs.lstat(resolved);
		if (candidate.isSymbolicLink()) {
			throw new Error("Refusing to delete a side session through a symbolic link.");
		}
		return await fs.realpath(resolved);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return path.join(candidateDir, path.basename(resolved));
		}
		throw error;
	}
}
async function removeSideSession(ctx: ExtensionContext, sessionFile: string): Promise<void> {
	const resolved = await managedSideSessionPath(ctx, sessionFile);
	const results = await Promise.allSettled([
		fs.rm(resolved, { force: true }),
		fs.rm(resolved.slice(0, -".jsonl".length), { recursive: true, force: true }),
	]);
	const failures = results
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map(result => errorMessage(result.reason));
	if (failures.length > 0) throw new Error(failures.join("; "));
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (!part || typeof part !== "object") return "";
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.join("")
		.trim();
}

function getHandoffIntent(entry: SessionEntry): HandoffIntent | undefined {
	if (entry.type !== "custom" || entry.customType !== HANDOFF_INTENT_TYPE) return undefined;
	const data = entry.data as Partial<HandoffIntent> | undefined;
	if (
		!data ||
		typeof data.requestId !== "string" ||
		typeof data.handoffPrompt !== "string" ||
		typeof data.createdAt !== "string"
	) {
		return undefined;
	}
	return {
		requestId: data.requestId,
		handoffPrompt: data.handoffPrompt,
		createdAt: data.createdAt,
	};
}

function getHandoffReady(entry: SessionEntry): HandoffReady | undefined {
	if (entry.type !== "custom" || entry.customType !== HANDOFF_READY_TYPE) return undefined;
	const data = entry.data as Partial<HandoffReady> | undefined;
	if (
		!data ||
		typeof data.requestId !== "string" ||
		typeof data.intentEntryId !== "string" ||
		typeof data.promptEntryId !== "string" ||
		typeof data.answerEntryId !== "string"
	) {
		return undefined;
	}
	return {
		requestId: data.requestId,
		intentEntryId: data.intentEntryId,
		promptEntryId: data.promptEntryId,
		answerEntryId: data.answerEntryId,
	};
}

function getHandoffImported(entry: SessionEntry): HandoffImported | undefined {
	if (entry.type !== "custom" || entry.customType !== HANDOFF_IMPORTED_TYPE) return undefined;
	const data = entry.data as Partial<HandoffImported> | undefined;
	if (
		!data ||
		typeof data.requestId !== "string" ||
		typeof data.childSessionId !== "string" ||
		typeof data.sideNumber !== "number" ||
		typeof data.importedAt !== "string"
	) {
		return undefined;
	}
	return {
		requestId: data.requestId,
		childSessionId: data.childSessionId,
		sideNumber: data.sideNumber,
		importedAt: data.importedAt,
	};
}

function importedHandoffIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		const imported = getHandoffImported(entry);
		if (imported) ids.add(imported.requestId);
		if (entry.type === "custom_message" && entry.customType === HANDOFF_MESSAGE_TYPE) {
			const details = entry.details as Partial<HandoffMessageDetails> | undefined;
			const requestId =
				(typeof details?.requestId === "string" && details.requestId) ||
				HANDOFF_ID_PATTERN.exec(extractMessageText(entry.content))?.[1];
			if (requestId) ids.add(requestId);
		}
	}
	return ids;
}

function pendingHandoffsFromBranch(
	branch: SessionEntry[],
	childSessionId: string,
	side: SideRecord,
	parentSessionId: string,
	importedIds: Set<string>,
): PendingHandoff[] {
	const markerEntry = branch.find(
		(entry): entry is CustomSessionEntry => entry.type === "custom" && entry.customType === CHILD_MARKER_TYPE,
	);
	const marker = markerEntry?.data as Partial<ChildMarker> | undefined;
	if (!marker || marker.parentSessionId !== parentSessionId) {
		throw new Error(`Side ${side.sideNumber} is not linked to this Main session.`);
	}

	const pending: PendingHandoff[] = [];
	for (let readyIndex = 0; readyIndex < branch.length; readyIndex++) {
		const readyEntry = branch[readyIndex];
		if (!readyEntry) continue;
		const ready = getHandoffReady(readyEntry);
		if (readyEntry.type === "custom" && readyEntry.customType === HANDOFF_READY_TYPE && !ready) {
			throw new Error(`Side ${side.sideNumber} has a malformed handoff record.`);
		}
		if (!ready || importedIds.has(ready.requestId)) continue;
		const intentIndex = branch.findIndex(entry => entry.id === ready.intentEntryId);
		const promptIndex = branch.findIndex(entry => entry.id === ready.promptEntryId);
		const answerIndex = branch.findIndex(entry => entry.id === ready.answerEntryId);
		if (intentIndex < 0 || promptIndex <= intentIndex || answerIndex <= promptIndex || readyIndex <= answerIndex) {
			throw new Error(`Side ${side.sideNumber} has an invalid handoff record.`);
		}
		const intentEntry = branch[intentIndex];
		const promptEntry = branch[promptIndex];
		const answerEntry = branch[answerIndex];
		if (!intentEntry || !promptEntry || !answerEntry) {
			throw new Error(`Side ${side.sideNumber} has an incomplete handoff record.`);
		}
		const intent = getHandoffIntent(intentEntry);
		if (
			!intent ||
			intent.requestId !== ready.requestId ||
			promptEntry.type !== "message" ||
			promptEntry.message.role !== "user" ||
			extractMessageText(promptEntry.message.content) !== intent.handoffPrompt ||
			answerEntry.type !== "message" ||
			answerEntry.message.role !== "assistant" ||
			answerEntry.message.stopReason !== "stop"
		) {
			throw new Error(`Side ${side.sideNumber} handoff provenance validation failed.`);
		}
		const content = extractMessageText(answerEntry.message.content);
		if (!content) {
			throw new Error(`Side ${side.sideNumber} handoff provenance validation failed.`);
		}
		pending.push({
			requestId: ready.requestId,
			childSessionId,
			side,
			content,
			createdAt: intent.createdAt,
		});
	}
	return pending;
}

async function pendingHandoffsForSide(
	pi: ExtensionApi,
	ctx: ExtensionContext,
	side: SideRecord,
	importedIds = importedHandoffIds(ctx),
): Promise<PendingHandoff[]> {
	if (!existsSync(side.sessionFile)) return [];
	const child = await pi.pi.SessionManager.open(side.sessionFile, ctx.sessionManager.getSessionDir(), undefined, {
		suppressBreadcrumb: true,
	});
	try {
		return pendingHandoffsFromBranch(
			child.getBranch(),
			child.getSessionId(),
			side,
			ctx.sessionManager.getSessionId(),
			importedIds,
		);
	} finally {
		await child.close();
	}
}

async function collectPendingHandoffs(
	pi: ExtensionApi,
	ctx: ExtensionContext,
	sides: SideRecord[],
): Promise<PendingHandoffScan> {
	const importedIds = importedHandoffIds(ctx);
	const results = await Promise.allSettled(sides.map(side => pendingHandoffsForSide(pi, ctx, side, importedIds)));
	const pending: PendingHandoff[] = [];
	const failures: HandoffScanFailure[] = [];
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		const side = sides[index];
		if (!result || !side) continue;
		if (result.status === "fulfilled") pending.push(...result.value);
		else failures.push({ side, error: result.reason });
	}
	pending.sort((left, right) => {
		const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
		if (byCreatedAt !== 0) return byCreatedAt;
		const bySide = left.side.sideNumber - right.side.sideNumber;
		return bySide !== 0 ? bySide : left.requestId.localeCompare(right.requestId);
	});
	return { pending, failures };
}

function clearHandoffScanNotifications(notified: Set<string>, paneId: string): void {
	const prefix = `handoff-scan-error:${paneId}:`;
	for (const key of notified) {
		if (key.startsWith(prefix)) notified.delete(key);
	}
}

function withoutSidePane(state: SideLayoutMarker, paneId: string): SideLayoutMarker {
	const paneNumbers = { ...(state.paneNumbers ?? {}) };
	delete paneNumbers[paneId];
	return {
		parentPaneId: state.parentPaneId,
		columns: state.columns
			.map(column => column.filter(candidate => candidate !== paneId))
			.filter(column => column.length > 0),
		paneNumbers,
		sides: (state.sides ?? []).filter(side => side.paneId !== paneId),
	};
}

function withDetachedSide(state: SideLayoutMarker, paneId: string): SideLayoutMarker {
	return {
		parentPaneId: state.parentPaneId,
		columns: state.columns
			.map(column => column.filter(candidate => candidate !== paneId))
			.filter(column => column.length > 0),
		paneNumbers: { ...(state.paneNumbers ?? {}) },
		sides: (state.sides ?? []).map(side => (side.paneId === paneId ? { ...side, detached: true } : side)),
	};
}

function appendLayoutState(pi: Pick<ExtensionApi, "appendEntry">, state: SideLayoutMarker): void {
	pi.appendEntry(LAYOUT_MARKER_TYPE, {
		parentPaneId: state.parentPaneId,
		columns: state.columns.map(column => [...column]),
		paneNumbers: { ...(state.paneNumbers ?? {}) },
		sides: (state.sides ?? []).map(side => ({ ...side })),
	} satisfies SideLayoutMarker);
}

async function herdrPaneExists(
	pi: Pick<ExtensionApi, "exec">,
	herdr: string,
	paneId: string,
): Promise<boolean | undefined> {
	let result: ExecResult;
	try {
		result = await pi.exec(herdr, ["pane", "process-info", "--pane", paneId], {
			timeout: EXEC_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
	if (!execFailure(result, "Herdr pane inspection failed")) return true;
	const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
	if (detail.includes("pane_not_found") || detail.includes("pane not found")) return false;
	return undefined;
}

async function waitForPaneClosed(pi: Pick<ExtensionApi, "exec">, herdr: string, paneId: string): Promise<boolean> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const exists = await herdrPaneExists(pi, herdr, paneId);
		if (exists === false) return true;
		if (exists === undefined) return false;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 100);
		await promise;
	}
	return false;
}

async function reconcileSideLifecycle(pi: ExtensionApi, ctx: ExtensionContext, notified: Set<string>): Promise<void> {
	if (childMarker(ctx) || process.env.HERDR_ENV !== "1") return;
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (!parentPaneId) return;
	let state = latestSideLayout(ctx, parentPaneId);
	if (!state) return;
	const herdr = herdrBinaryPath();
	let changed = false;

	for (const side of [...(state.sides ?? [])]) {
		if (side.detached) continue;
		const exists = await herdrPaneExists(pi, herdr, side.paneId);
		if (exists !== false) continue;
		state = withDetachedSide(state, side.paneId);
		changed = true;
		const key = `detached:${side.paneId}`;
		if (!notified.has(key)) {
			notified.add(key);
			ctx.ui.notify(
				`Side ${side.sideNumber} pane closed; its session was retained. Use /side reopen ${side.sideNumber} or /side close ${side.sideNumber}.`,
				"info",
			);
		}
	}

	const trackedPaneIds = new Set((state.sides ?? []).map(side => side.paneId));
	for (const paneId of state.columns.flat()) {
		if (trackedPaneIds.has(paneId)) continue;
		const exists = await herdrPaneExists(pi, herdr, paneId);
		if (exists === false) {
			state = withoutSidePane(state, paneId);
			changed = true;
		}
	}
	if (changed) appendLayoutState(pi, state);

	try {
		const scan = await collectPendingHandoffs(pi, ctx, state.sides ?? []);
		const failedPaneIds = new Set(scan.failures.map(failure => failure.side.paneId));
		for (const side of state.sides ?? []) {
			if (!failedPaneIds.has(side.paneId)) clearHandoffScanNotifications(notified, side.paneId);
		}
		for (const failure of scan.failures) {
			const detail = errorMessage(failure.error);
			const key = `handoff-scan-error:${failure.side.paneId}:${detail}`;
			if (notified.has(key)) continue;
			notified.add(key);
			ctx.ui.notify(`Could not inspect Side ${failure.side.sideNumber}'s handoffs: ${detail}`, "warning");
		}
		for (const handoff of scan.pending) {
			if (!importPendingHandoff(pi, ctx, handoff)) continue;
			ctx.ui.notify(
				`Automatically imported Side ${handoff.side.sideNumber}'s handoff without starting a turn.`,
				"info",
			);
		}
	} catch (error) {
		const key = `handoff-scan-error:${errorMessage(error)}`;
		if (!notified.has(key)) {
			notified.add(key);
			ctx.ui.notify(`Could not inspect side handoffs: ${errorMessage(error)}`, "warning");
		}
	}
}

async function runSideList(pi: ExtensionApi, ctx: ExtensionCommandContext): Promise<void> {
	if (childMarker(ctx)) {
		ctx.ui.notify("/side list must be run from Main.", "warning");
		return;
	}
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !parentPaneId) {
		ctx.ui.notify("/side list requires Main to be running inside Herdr.", "error");
		return;
	}
	await reconcileSideLifecycle(pi, ctx, new Set());
	const sides = latestSideLayout(ctx, parentPaneId)?.sides ?? [];
	if (sides.length === 0) {
		ctx.ui.notify("No tracked side conversations.", "info");
		return;
	}
	const lines = sides
		.toSorted((left, right) => left.sideNumber - right.sideNumber)
		.map(side => {
			const status = side.detached ? `detached; /side reopen ${side.sideNumber}` : "open";
			return `Side ${side.sideNumber} [${status}] ${sideDisplayTitle(side)}`;
		});
	ctx.ui.notify(`Side conversations:\n${lines.join("\n")}`, "info");
}

async function runSideClose(pi: ExtensionApi, ctx: ExtensionCommandContext, rawTarget: string): Promise<void> {
	if (childMarker(ctx)) {
		ctx.ui.notify("Run /side close from Main to close this side safely.", "warning");
		return;
	}
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !parentPaneId) {
		ctx.ui.notify("/side close requires Main to be running inside Herdr.", "error");
		return;
	}
	await reconcileSideLifecycle(pi, ctx, new Set());
	const state = latestSideLayout(ctx, parentPaneId);
	const sides = state?.sides ?? [];
	if (!state || sides.length === 0) {
		ctx.ui.notify("No active side conversations.", "info");
		return;
	}

	let selected: SideRecord | undefined;
	const target = rawTarget.trim();
	if (target) {
		const sideNumber = Number(target);
		selected = Number.isInteger(sideNumber) ? sides.find(side => side.sideNumber === sideNumber) : undefined;
		if (!selected) {
			ctx.ui.notify(`No active Side ${target}.`, "warning");
			return;
		}
	} else if (sides.length === 1) {
		selected = sides[0];
	} else {
		const labels = sides
			.toSorted((left, right) => left.sideNumber - right.sideNumber)
			.map(side => `Side ${side.sideNumber}: ${sideDisplayTitle(side)}`);
		const choice = await ctx.ui.select("Choose a side conversation to close", labels);
		if (!choice) return;
		const match = /^Side (\d+):/.exec(choice);
		selected = match ? sides.find(side => side.sideNumber === Number(match[1])) : undefined;
		if (!selected) {
			ctx.ui.notify("The selected side is no longer available.", "warning");
			return;
		}
	}

	let pending: PendingHandoff[];
	try {
		pending = await pendingHandoffsForSide(pi, ctx, selected);
	} catch (error) {
		ctx.ui.notify(`Cannot safely close Side ${selected.sideNumber}: ${errorMessage(error)}`, "error");
		return;
	}
	const approvedPendingIds = new Set(pending.map(handoff => handoff.requestId));
	const pendingWarning =
		pending.length === 0
			? ""
			: ` This also discards ${pending.length} pending handoff${pending.length === 1 ? "" : "s"}.`;
	const confirmed = await ctx.ui.confirm(
		`Close Side ${selected.sideNumber}?`,
		`${selected.detached ? "Permanently delete" : "Close its Herdr pane and permanently delete"} ${selected.sessionFile}?${pendingWarning}`,
	);
	if (!confirmed) return;

	const herdr = herdrBinaryPath();
	if (!selected.detached) {
		const exists = await herdrPaneExists(pi, herdr, selected.paneId);
		if (exists === undefined) {
			ctx.ui.notify(`Could not inspect Side ${selected.sideNumber}'s Herdr pane.`, "error");
			return;
		}
		if (exists) {
			const closed = await pi.exec(herdr, ["pane", "close", selected.paneId], {
				timeout: EXEC_TIMEOUT_MS,
			});
			const closeFailure = execFailure(closed, "Herdr pane close failed");
			if (closeFailure || !(await waitForPaneClosed(pi, herdr, selected.paneId))) {
				ctx.ui.notify(
					`Could not confirm that Side ${selected.sideNumber} exited: ${closeFailure ?? "pane remained open"}`,
					"error",
				);
				return;
			}
		}
	}

	try {
		pending = await pendingHandoffsForSide(pi, ctx, selected);
		const newPending = pending.filter(handoff => !approvedPendingIds.has(handoff.requestId));
		if (newPending.length > 0) {
			ctx.ui.notify(
				`Side ${selected.sideNumber} closed with a new handoff created after confirmation. Import it before cleanup.`,
				"warning",
			);
			return;
		}
		await removeSideSession(ctx, selected.sessionFile);
		const current = latestSideLayout(ctx, parentPaneId) ?? state;
		appendLayoutState(pi, withoutSidePane(current, selected.paneId));
		ctx.ui.notify(`Closed and deleted Side ${selected.sideNumber}.`, "info");
	} catch (error) {
		ctx.ui.notify(
			`Side ${selected.sideNumber} closed, but its session was retained for cleanup: ${errorMessage(error)}`,
			"warning",
		);
	}
}

async function rollbackBoundaryResize(
	pi: Pick<ExtensionApi, "exec">,
	herdr: string,
	resize: BoundaryResize | undefined,
): Promise<string | undefined> {
	if (!resize) return undefined;
	try {
		const result = await pi.exec(
			herdr,
			[
				"pane",
				"resize",
				"--pane",
				resize.rollbackPaneId,
				"--direction",
				resize.rollbackDirection,
				"--amount",
				String(resize.amount),
			],
			{ timeout: EXEC_TIMEOUT_MS },
		);
		return execFailure(result, "Herdr layout rollback failed");
	} catch (error) {
		return `Herdr layout rollback failed: ${errorMessage(error)}`;
	}
}

export async function launchHerdrSide(
	pi: Pick<ExtensionApi, "exec">,
	ctx: Pick<ExtensionContext, "cwd">,
	placement: SidePanePlacement,
	sessionFile: string,
	title: string,
	bootstrapCommand = INTERNAL_LAUNCH_COMMAND,
): Promise<LaunchResult> {
	const herdr = herdrBinaryPath();
	if (placement.resize) {
		let resized: ExecResult;
		try {
			resized = await pi.exec(
				herdr,
				[
					"pane",
					"resize",
					"--pane",
					placement.resize.paneId,
					"--direction",
					placement.resize.direction,
					"--amount",
					String(placement.resize.amount),
				],
				{ timeout: EXEC_TIMEOUT_MS },
			);
		} catch (error) {
			return { ok: false, reason: errorMessage(error), canDeleteSession: true };
		}
		const resizeFailure = execFailure(resized, "Herdr pane resize failed");
		if (resizeFailure) return { ok: false, reason: resizeFailure, canDeleteSession: true };
	}

	let split: ExecResult;
	try {
		split = await pi.exec(
			herdr,
			[
				"pane",
				"split",
				"--pane",
				placement.targetPaneId,
				"--direction",
				placement.direction,
				"--ratio",
				String(placement.ratio),
				"--cwd",
				ctx.cwd,
				"--env",
				"HERDR_AGENT=omp",
				"--no-focus",
			],
			{ timeout: EXEC_TIMEOUT_MS },
		);
	} catch (error) {
		return { ok: false, reason: errorMessage(error), canDeleteSession: false };
	}
	const splitFailure = execFailure(split, "Herdr pane split failed");
	if (splitFailure) {
		const rollbackFailure = split.killed ? undefined : await rollbackBoundaryResize(pi, herdr, placement.resize);
		return {
			ok: false,
			reason: rollbackFailure ? `${splitFailure}; ${rollbackFailure}` : splitFailure,
			canDeleteSession: !split.killed,
		};
	}

	let paneId: string;
	try {
		paneId = parseHerdrPaneId(split.stdout);
	} catch (error) {
		return {
			ok: false,
			reason: `Could not parse the new Herdr pane id: ${errorMessage(error)}`,
			canDeleteSession: false,
		};
	}

	const agentName = `omp-side-${placement.sideNumber}-${randomUUID().slice(0, 8)}`;
	const startArgs = [
		"agent",
		"start",
		agentName,
		"--kind",
		"omp",
		"--pane",
		paneId,
		"--timeout",
		"10000",
		"--",
		"--resume",
		sessionFile,
	];
	let started: ExecResult;
	try {
		started = await pi.exec(herdr, startArgs, { timeout: EXEC_TIMEOUT_MS });
		for (
			let attempt = 1;
			attempt < START_MAX_ATTEMPTS && !started.killed && started.code !== 0 && isPaneBusy(started);
			attempt++
		) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, START_RETRY_DELAY_MS);
			await promise;
			started = await pi.exec(herdr, startArgs, { timeout: EXEC_TIMEOUT_MS });
		}
	} catch (error) {
		return { ok: false, paneId, reason: errorMessage(error), canDeleteSession: false };
	}
	const startFailure = execFailure(started, "Herdr OMP agent start failed");
	if (startFailure) {
		if (started.killed) return { ok: false, paneId, reason: startFailure, canDeleteSession: false };
		try {
			const closed = await pi.exec(herdr, ["pane", "close", paneId], { timeout: 5_000 });
			const closeFailure = execFailure(closed, "Herdr pane cleanup failed");
			if (closeFailure) {
				return {
					ok: false,
					paneId,
					reason: `${startFailure}; pane cleanup retained: ${closeFailure}`,
					canDeleteSession: false,
				};
			}
			const rollbackFailure = await rollbackBoundaryResize(pi, herdr, placement.resize);
			return {
				ok: false,
				reason: rollbackFailure ? `${startFailure}; ${rollbackFailure}` : startFailure,
				canDeleteSession: true,
			};
		} catch (error) {
			return {
				ok: false,
				paneId,
				reason: `${startFailure}; pane cleanup retained: ${errorMessage(error)}`,
				canDeleteSession: false,
			};
		}
	}

	let warning: string | undefined;
	try {
		const renamed = await pi.exec(herdr, ["pane", "rename", paneId, title], {
			timeout: EXEC_TIMEOUT_MS,
		});
		warning = execFailure(renamed, "Herdr side-pane rename failed");
	} catch (error) {
		warning = `Herdr side-pane rename failed: ${errorMessage(error)}`;
	}

	try {
		const sent = await pi.exec(herdr, ["agent", "prompt", agentName, bootstrapCommand], {
			timeout: EXEC_TIMEOUT_MS,
		});
		const promptFailure = execFailure(sent, "Herdr side bootstrap failed");
		if (promptFailure) {
			return {
				ok: false,
				agentName,
				paneId,
				agentStarted: true,
				reason: promptFailure,
				warning,
				canDeleteSession: false,
			};
		}
	} catch (error) {
		return {
			ok: false,
			agentName,
			paneId,
			agentStarted: true,
			reason: errorMessage(error),
			warning,
			canDeleteSession: false,
		};
	}
	return { ok: true, agentName, paneId, agentStarted: true, warning };
}

function latestUnfinalizedHandoff(branch: SessionEntry[]): { entry: SessionEntry; intent: HandoffIntent } | undefined {
	const finalized = new Set(
		branch
			.map(getHandoffReady)
			.filter((ready): ready is HandoffReady => ready !== undefined)
			.map(ready => ready.requestId),
	);
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry) continue;
		const intent = getHandoffIntent(entry);
		if (intent && !finalized.has(intent.requestId)) return { entry, intent };
	}
	return undefined;
}

async function finalizePendingChildHandoff(
	pi: Pick<ExtensionApi, "appendEntry">,
	ctx: ExtensionContext,
): Promise<void> {
	if (!childMarker(ctx)) return;
	const branch = ctx.sessionManager.getBranch();
	const pending = latestUnfinalizedHandoff(branch);
	if (!pending) return;
	const intentIndex = branch.findIndex(entry => entry.id === pending.entry.id);
	let promptEntry: MessageSessionEntry | undefined;
	let answerEntry: MessageSessionEntry | undefined;
	for (let index = intentIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "user") {
			if (promptEntry || extractMessageText(entry.message.content) !== pending.intent.handoffPrompt) return;
			promptEntry = entry;
			continue;
		}
		if (!promptEntry) continue;
		if (entry.message?.role === "assistant" && entry.message.stopReason === "stop") {
			answerEntry = entry;
		}
	}
	if (
		!promptEntry ||
		!answerEntry ||
		!("content" in answerEntry.message) ||
		!extractMessageText(answerEntry.message.content)
	) {
		return;
	}
	pi.appendEntry(HANDOFF_READY_TYPE, {
		requestId: pending.intent.requestId,
		intentEntryId: pending.entry.id,
		promptEntryId: promptEntry.id,
		answerEntryId: answerEntry.id,
	} satisfies HandoffReady);
	ctx.ui.notify("Handoff ready. It will appear in Main when Main is idle.", "info");
}

async function runSideHandoff(pi: ExtensionApi, ctx: ExtensionCommandContext, focus: string): Promise<void> {
	const marker = childMarker(ctx);
	if (!marker) {
		ctx.ui.notify("/side handoff must be run from a side conversation.", "warning");
		return;
	}
	await ctx.waitForIdle();
	if (latestUnfinalizedHandoff(ctx.sessionManager.getBranch())) {
		ctx.ui.notify("This side is already preparing a handoff.", "warning");
		return;
	}
	const handoffPrompt = focus.trim()
		? `${HANDOFF_PROMPT}\n\nAdditional focus from the user: ${focus.trim()}`
		: HANDOFF_PROMPT;
	pi.appendEntry(HANDOFF_INTENT_TYPE, {
		requestId: randomUUID(),
		handoffPrompt,
		createdAt: new Date().toISOString(),
	} satisfies HandoffIntent);
	pi.sendUserMessage(handoffPrompt);
	ctx.ui.notify("Preparing the side handoff.", "info");
}

function handoffImportContent(handoff: PendingHandoff): string {
	return `Imported handoff from Side ${handoff.side.sideNumber}: ${sideDisplayTitle(handoff.side)}\n\n---\n\n${handoff.content}\n\n<!-- omp-side-handoff:${handoff.requestId} -->`;
}

function importPendingHandoff(
	pi: Pick<ExtensionApi, "sendMessage">,
	ctx: ExtensionContext,
	handoff: PendingHandoff,
): boolean {
	const importedIds = importedHandoffIds(ctx);
	let pendingIds = pendingHandoffDeliveries.get(pi);
	if (!pendingIds) {
		pendingIds = new Map();
		pendingHandoffDeliveries.set(pi, pendingIds);
	}
	const now = Date.now();
	for (const [requestId, expiresAt] of pendingIds) {
		if (importedIds.has(requestId) || expiresAt <= now) pendingIds.delete(requestId);
	}
	if (importedIds.has(handoff.requestId) || pendingIds.has(handoff.requestId)) return false;
	pendingIds.set(handoff.requestId, now + HANDOFF_DELIVERY_CLAIM_MS);
	try {
		pi.sendMessage(
			{
				customType: HANDOFF_MESSAGE_TYPE,
				content: handoffImportContent(handoff),
				details: {
					requestId: handoff.requestId,
					childSessionId: handoff.childSessionId,
					sideNumber: handoff.side.sideNumber,
				} satisfies HandoffMessageDetails,
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn", triggerTurn: false },
		);
	} catch (error) {
		pendingIds.delete(handoff.requestId);
		throw error;
	}
	return true;
}

async function runMainRecovery(pi: ExtensionApi, ctx: ExtensionCommandContext, rawTarget: string): Promise<void> {
	if (childMarker(ctx)) {
		ctx.ui.notify("/side recover must be run from Main.", "warning");
		return;
	}
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !parentPaneId) {
		ctx.ui.notify("/side recover requires Main to be running inside Herdr.", "error");
		return;
	}
	const state = latestSideLayout(ctx, parentPaneId);
	if (!state) {
		ctx.ui.notify("No side handoffs are available.", "info");
		return;
	}
	let scan: PendingHandoffScan;
	try {
		scan = await collectPendingHandoffs(pi, ctx, state.sides ?? []);
	} catch (error) {
		ctx.ui.notify(`Could not inspect side handoffs: ${errorMessage(error)}`, "error");
		return;
	}
	for (const failure of scan.failures) {
		ctx.ui.notify(
			`Could not inspect Side ${failure.side.sideNumber}'s handoffs: ${errorMessage(failure.error)}`,
			"warning",
		);
	}
	let pending = scan.pending;
	const target = rawTarget.trim();
	if (target) {
		const sideNumber = Number(target);
		if (!Number.isInteger(sideNumber)) {
			ctx.ui.notify("Use /side recover <side-number> in Main.", "warning");
			return;
		}
		if (scan.failures.some(failure => failure.side.sideNumber === sideNumber)) return;
		pending = pending.filter(handoff => handoff.side.sideNumber === sideNumber);
	}
	if (pending.length === 0) {
		ctx.ui.notify(target ? `Side ${target} has no pending handoff.` : "No side handoffs are available.", "info");
		return;
	}

	let selected: PendingHandoff | undefined = pending[0];
	if (pending.length > 1) {
		const labels = pending.map(
			handoff =>
				`Side ${handoff.side.sideNumber} [${handoff.requestId.slice(0, 8)}]: ${handoff.content.replace(/\s+/g, " ").slice(0, 72)}`,
		);
		const choice = await ctx.ui.select("Choose a side handoff to import", labels);
		if (!choice) return;
		const requestPrefix = /\[([^\]]+)\]/.exec(choice)?.[1];
		selected = pending.find(handoff => handoff.requestId.startsWith(requestPrefix ?? ""));
		if (!selected) {
			ctx.ui.notify("The selected handoff is no longer available.", "warning");
			return;
		}
	}
	if (!selected) return;

	if (!importPendingHandoff(pi, ctx, selected)) {
		ctx.ui.notify("That handoff was already imported.", "info");
		return;
	}
	ctx.ui.notify(`Recovered Side ${selected.side.sideNumber}'s handoff without starting a turn.`, "info");
}

async function runInternalLaunch(pi: ExtensionApi, ctx: ExtensionCommandContext): Promise<void> {
	const marker = childMarker(ctx);
	if (!marker) {
		ctx.ui.notify("/side --launch is only valid inside a side session.", "warning");
		return;
	}
	await ctx.waitForIdle();
	pi.sendMessage(
		{
			customType: "omp-side-session-context-v1",
			content:
				"This conversation state is independent from Main, but both processes share the same working directory, files, Git worktree, and services. Answer the side request without continuing Main's task or modifying shared state unless the user explicitly asks you to do so; avoid concurrent edits with Main.",
			display: false,
			attribution: "agent",
		},
		{ deliverAs: "nextTurn", triggerTurn: false },
	);
	if (!marker.prompt) {
		ctx.ui.notify("Side conversation ready.", "info");
		return;
	}
	pi.sendUserMessage(marker.prompt);
	ctx.ui.notify("Started the side conversation.", "info");
}

async function runInternalReopen(ctx: ExtensionCommandContext): Promise<void> {
	if (!childMarker(ctx)) {
		ctx.ui.notify("/side --reopen is only valid inside a side session.", "warning");
		return;
	}
	await ctx.waitForIdle();
	ctx.ui.notify("Side conversation resumed.", "info");
}

function recordSidePane(
	pi: Pick<ExtensionApi, "appendEntry">,
	parentPaneId: string,
	resolved: ResolvedSideLayout,
	placement: SidePanePlacement,
	existingSides: SideRecord[],
	side: SideRecord,
): void {
	const columns = resolved.columns.map(column => [...column]);
	if (placement.newColumn) {
		if (placement.columnIndex !== columns.length) {
			throw new Error("The new side column no longer matches the tracked layout.");
		}
		columns.push([side.paneId]);
	} else {
		const column = columns[placement.columnIndex];
		if (!column || column.length >= 2) {
			throw new Error("The target side column is no longer available.");
		}
		column.push(side.paneId);
	}
	const paneNumbers = { ...resolved.paneNumbers, [side.paneId]: placement.sideNumber };
	appendLayoutState(pi, {
		parentPaneId,
		columns,
		paneNumbers,
		sides: [
			...existingSides.filter(existing => existing.paneId !== side.paneId && existing.sideNumber !== side.sideNumber),
			side,
		],
	});
}

async function runSideReopen(pi: ExtensionApi, ctx: ExtensionCommandContext, rawTarget: string): Promise<void> {
	if (childMarker(ctx)) {
		ctx.ui.notify("/side reopen must be run from Main.", "warning");
		return;
	}
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !parentPaneId) {
		ctx.ui.notify("/side reopen requires Main to be running inside Herdr.", "error");
		return;
	}
	await reconcileSideLifecycle(pi, ctx, new Set());
	const state = latestSideLayout(ctx, parentPaneId);
	const detachedSides = (state?.sides ?? []).filter(side => side.detached);
	if (!state || detachedSides.length === 0) {
		ctx.ui.notify("No detached side conversations.", "info");
		return;
	}

	let selected: SideRecord | undefined;
	const target = rawTarget.trim();
	if (target) {
		const sideNumber = Number(target);
		selected = Number.isInteger(sideNumber) ? detachedSides.find(side => side.sideNumber === sideNumber) : undefined;
		if (!selected) {
			ctx.ui.notify(`No detached Side ${target}.`, "warning");
			return;
		}
	} else if (detachedSides.length === 1) {
		selected = detachedSides[0];
	} else {
		const labels = detachedSides
			.toSorted((left, right) => left.sideNumber - right.sideNumber)
			.map(side => `Side ${side.sideNumber}: ${sideDisplayTitle(side)}`);
		const choice = await ctx.ui.select("Choose a side conversation to reopen", labels);
		if (!choice) return;
		const match = /^Side (\d+):/.exec(choice);
		selected = match ? detachedSides.find(side => side.sideNumber === Number(match[1])) : undefined;
		if (!selected) {
			ctx.ui.notify("The selected side is no longer available.", "warning");
			return;
		}
	}
	if (!existsSync(selected.sessionFile)) {
		ctx.ui.notify(
			`Cannot reopen Side ${selected.sideNumber}; its session file is missing. Use /side close ${selected.sideNumber} to remove the stale record.`,
			"error",
		);
		return;
	}

	let resolved: ResolvedSideLayout;
	try {
		const inspected = await pi.exec(herdrBinaryPath(), ["pane", "layout", "--pane", parentPaneId], {
			timeout: EXEC_TIMEOUT_MS,
		});
		const inspectFailure = execFailure(inspected, "Herdr pane layout inspection failed");
		if (inspectFailure) throw new Error(inspectFailure);
		const paneNumbers = { ...(state.paneNumbers ?? {}) };
		delete paneNumbers[selected.paneId];
		resolved = resolveSideLayout(parentPaneId, state.columns, parseHerdrPaneLayout(inspected.stdout), paneNumbers);
	} catch (error) {
		ctx.ui.notify(`Could not inspect the side-pane layout: ${errorMessage(error)}`, "error");
		return;
	}
	if (!resolved.placement) {
		ctx.ui.notify("Four side conversations are already open. Close one before reopening another.", "warning");
		return;
	}
	const placement = { ...resolved.placement, sideNumber: selected.sideNumber };
	const launched = await launchHerdrSide(
		pi,
		ctx,
		placement,
		selected.sessionFile,
		selected.title,
		INTERNAL_REOPEN_COMMAND,
	);
	if (launched.agentStarted && launched.paneId) {
		try {
			if (!launched.agentName) throw new Error("The reopened Herdr agent name is missing.");
			recordSidePane(pi, parentPaneId, resolved, placement, state.sides ?? [], {
				...selected,
				paneId: launched.paneId,
				agentName: launched.agentName,
				detached: false,
			});
		} catch (error) {
			ctx.ui.notify(
				`Reopened ${launched.agentName ?? `Side ${selected.sideNumber}`}, but could not save its lifecycle state: ${errorMessage(error)}`,
				"error",
			);
			return;
		}
	}
	if (!launched.ok) {
		ctx.ui.notify(
			launched.agentStarted
				? `Reopened Side ${selected.sideNumber}, but could not finish its private bootstrap: ${launched.reason}. Continue in the side pane.`
				: `Could not reopen Side ${selected.sideNumber}: ${launched.reason}. Its session was retained.`,
			"error",
		);
		return;
	}
	if (launched.warning) {
		ctx.ui.notify(`Side ${selected.sideNumber} reopened with a labeling warning: ${launched.warning}`, "warning");
	}
	ctx.ui.notify(`Reopened Side ${selected.sideNumber} in the paired layout.`, "info");
}

async function runSide(pi: ExtensionApi, ctx: ExtensionCommandContext, rawPrompt: string): Promise<void> {
	if (childMarker(ctx)) {
		ctx.ui.notify("Nested /side sessions are disabled; continue in this side conversation.", "warning");
		return;
	}
	if (process.env.HERDR_ENV !== "1") {
		ctx.ui.notify("/side needs an active Herdr session. OMP has no native side-by-side conversation pane.", "error");
		return;
	}
	const parentPaneId = process.env.HERDR_PANE_ID;
	if (!parentPaneId) {
		ctx.ui.notify("Herdr is active but HERDR_PANE_ID is missing.", "error");
		return;
	}
	const parentSessionFile = ctx.sessionManager.getSessionFile();
	if (!parentSessionFile || !existsSync(parentSessionFile)) {
		ctx.ui.notify("Main is not persisted yet. Complete one Main turn before opening Side.", "warning");
		return;
	}
	await reconcileSideLifecycle(pi, ctx, new Set());

	const stored = latestSideLayout(ctx, parentPaneId);
	if ((stored?.sides ?? []).length >= MAX_SIDE_PANES) {
		ctx.ui.notify(
			"Four side conversations are already tracked for this main pane. Close one before opening another.",
			"warning",
		);
		return;
	}
	const herdr = herdrBinaryPath();
	let resolved: ResolvedSideLayout;
	try {
		const inspected = await pi.exec(herdr, ["pane", "layout", "--pane", parentPaneId], {
			timeout: EXEC_TIMEOUT_MS,
		});
		const inspectFailure = execFailure(inspected, "Herdr pane layout inspection failed");
		if (inspectFailure) throw new Error(inspectFailure);
		const layout = parseHerdrPaneLayout(inspected.stdout);
		resolved = resolveSideLayout(parentPaneId, stored?.columns ?? [], layout, stored?.paneNumbers ?? {});
	} catch (error) {
		ctx.ui.notify(`Could not inspect the side-pane layout: ${errorMessage(error)}`, "error");
		return;
	}
	if (!resolved.placement) {
		ctx.ui.notify(
			"Four side conversations are already open for this main pane. Close one before opening another.",
			"warning",
		);
		return;
	}

	const prompt = rawPrompt.trim() || undefined;
	let created: CreatedSideSession;
	try {
		created = await createSideSession(pi, ctx, parentPaneId, resolved.placement.sideNumber, prompt);
	} catch (error) {
		ctx.ui.notify(`Could not create the side session: ${errorMessage(error)}`, "error");
		return;
	}

	const launched = await launchHerdrSide(pi, ctx, resolved.placement, created.sessionFile, created.title);
	if (launched.agentStarted && launched.paneId) {
		try {
			if (!launched.agentName) throw new Error("The launched Herdr agent name is missing.");
			recordSidePane(pi, parentPaneId, resolved, resolved.placement, stored?.sides ?? [], {
				sideNumber: resolved.placement.sideNumber,
				paneId: launched.paneId,
				agentName: launched.agentName,
				sessionFile: created.sessionFile,
				title: created.title,
			});
		} catch (error) {
			ctx.ui.notify(
				`Opened ${launched.agentName ?? "the side session"}, but could not save its lifecycle state: ${errorMessage(error)}`,
				"error",
			);
			return;
		}
	}
	if (!launched.ok) {
		if (launched.canDeleteSession) {
			try {
				await removeSideSession(ctx, created.sessionFile);
			} catch (error) {
				ctx.ui.notify(`Could not remove the failed side session: ${errorMessage(error)}`, "warning");
			}
		}
		if (launched.agentStarted) {
			ctx.ui.notify(
				`Opened ${launched.agentName ?? "the side session"}, but could not finish its private bootstrap: ${launched.reason}. Continue in the side pane.`,
				"error",
			);
			return;
		}
		const retained = launched.canDeleteSession ? "" : ` Session retained at ${created.sessionFile}.`;
		ctx.ui.notify(`Could not open the side session: ${launched.reason}.${retained}`, "error");
		return;
	}
	if (launched.warning) {
		ctx.ui.notify(
			`Side ${resolved.placement.sideNumber} opened with a labeling warning: ${launched.warning}`,
			"warning",
		);
	}
	ctx.ui.notify(
		prompt
			? `Opened Side ${resolved.placement.sideNumber} in the paired layout and sent the question.`
			: `Opened Side ${resolved.placement.sideNumber} in the paired layout; focus it to begin.`,
		"info",
	);
}

function completeSideArguments(argumentPrefix: string): SideArgumentCompletion[] | null {
	if (argumentPrefix.includes(" ")) return null;
	const lower = argumentPrefix.toLowerCase();
	const matches = [
		{
			value: "-- ",
			label: "--",
			description: "Open a question beginning with a reserved command word",
			hint: "[question]",
		},
		{
			value: "close ",
			label: "close",
			description: "Close and delete a paired Side from Main",
			hint: "[number]",
		},
		{
			value: "reopen ",
			label: "reopen",
			description: "Reopen a detached Side from Main",
			hint: "[number]",
		},
		{
			value: "list",
			label: "list",
			description: "List open and detached Sides from Main",
			hint: "",
		},
		{
			value: "handoff ",
			label: "handoff",
			description: "Prepare a handoff from this Side",
			hint: "[instructions]",
		},
		{
			value: "recover ",
			label: "recover",
			description: "Recover a pending handoff in Main",
			hint: "[number]",
		},
	].filter(item => item.label.startsWith(lower));
	return matches.length > 0 ? matches : null;
}

export default function ompSideSession(pi: ExtensionApi): void {
	let pollTimer: Timer | undefined;
	let pollContext: ExtensionContext | undefined;
	let pollGeneration = 0;
	let maintenanceInFlight = false;
	const notified = new Set<string>();

	const stopPolling = (): void => {
		pollGeneration++;
		if (pollTimer && pollContext) pollContext.clearTimer(pollTimer);
		pollTimer = undefined;
		pollContext = undefined;
		maintenanceInFlight = false;
		notified.clear();
	};
	const maintain = async (ctx: ExtensionContext, generation: number): Promise<void> => {
		if (generation !== pollGeneration || maintenanceInFlight) return;
		if (!ctx.isIdle()) return;
		maintenanceInFlight = true;
		try {
			if (childMarker(ctx)) {
				await finalizePendingChildHandoff(pi, ctx);
			} else {
				await reconcileSideLifecycle(pi, ctx, notified);
			}
		} catch (error) {
			ctx.ui.notify(`Side-session maintenance failed: ${errorMessage(error)}`, "warning");
		} finally {
			maintenanceInFlight = false;
		}
	};
	const startPolling = (ctx: ExtensionContext): void => {
		stopPolling();
		const generation = pollGeneration;
		void maintain(ctx, generation);
		if (childMarker(ctx) || process.env.HERDR_ENV !== "1") return;
		pollContext = ctx;
		pollTimer = ctx.setInterval(() => void maintain(ctx, generation), LIFECYCLE_POLL_INTERVAL_MS);
	};

	pi.on("session_start", async (_event, ctx) => startPolling(ctx));
	pi.on("session_switch", async (_event, ctx) => startPolling(ctx));
	pi.on("agent_end", async (event, ctx) => {
		if (event.willContinue) return;
		if (childMarker(ctx)) {
			await finalizePendingChildHandoff(pi, ctx);
		} else {
			await reconcileSideLifecycle(pi, ctx, notified);
		}
	});
	pi.on("session_shutdown", async () => stopPolling());

	pi.registerCommand("side", {
		description: "Open, list, close, reopen, hand off, or recover a paired Herdr side conversation",
		getArgumentCompletions: completeSideArguments,
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "--launch") {
				await runInternalLaunch(pi, ctx);
				return;
			}
			if (trimmed === "--reopen") {
				await runInternalReopen(ctx);
				return;
			}
			if (trimmed === "--" || trimmed.startsWith("-- ")) {
				await runSide(pi, ctx, trimmed === "--" ? "" : trimmed.slice(3));
				return;
			}
			const [verb = "", ...rest] = trimmed.split(/\s+/);
			if (verb === "close") {
				await runSideClose(pi, ctx, rest.join(" "));
				return;
			}
			if (verb === "reopen") {
				await runSideReopen(pi, ctx, rest.join(" "));
				return;
			}
			if (verb === "list") {
				await runSideList(pi, ctx);
				return;
			}
			if (verb === "handoff") {
				await runSideHandoff(pi, ctx, rest.join(" "));
				return;
			}
			if (verb === "recover") {
				await runMainRecovery(pi, ctx, rest.join(" "));
				return;
			}
			await runSide(pi, ctx, trimmed);
		},
	});
}
