import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BAND_THRESHOLDS, type Band, aggregateConsumers, band, deriveState, fmtTokens } from "./context.ts";

type PiTheme = ExtensionContext["ui"]["theme"];

interface GaugeInput {
	tokens: number | null;
	window?: number;
	barWidth?: number;
}

function bandText(theme: PiTheme, value: Band, text: string): string {
	if (value === "red") return theme.fg("error", text);
	if (value === "filling") return theme.fg("warning", text);
	return theme.fg("success", text);
}

export function renderGauge(input: GaugeInput, theme: PiTheme): string {
	const barWidth = input.barWidth ?? 30;
	if (input.tokens === null || !input.window || input.window <= 0) {
		return `${theme.fg("dim", "CONTEXT")} ${theme.fg("dim", "░".repeat(barWidth))} ${theme.fg(
			"dim",
			"estimating… (awaiting next turn)",
		)}`;
	}
	const pct = (input.tokens / input.window) * 100;
	const value = band(pct);
	const fill = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
	const ticks = new Set(
		[BAND_THRESHOLDS.healthy, BAND_THRESHOLDS.filling, BAND_THRESHOLDS.red].map((threshold) =>
			Math.min(barWidth - 1, Math.round((threshold / 100) * barWidth)),
		),
	);
	let barText = "";
	for (let index = 0; index < barWidth; index++) {
		const character = index < fill ? "█" : ticks.has(index) ? "┊" : "░";
		barText += index < fill ? bandText(theme, value, character) : theme.fg("dim", character);
	}
	const label = `${fmtTokens(input.tokens)} / ${fmtTokens(input.window)} · ${bandText(
		theme,
		value,
		`${pct.toFixed(1)}% ${value}`,
	)}`;
	return `${theme.fg("dim", "CONTEXT")} ${barText} ${label}`;
}

let warnedRed = false;
let lastPct: number | null = null;
let lastConsumers = new Map<string, number>();
const TREND_PTS = 3;
const ATTRIBUTE_PTS = 5;

export function resetAmbient(): void {
	warnedRed = false;
	lastPct = null;
	lastConsumers = new Map();
}

function trendMarker(pct: number, consumers: Map<string, number>): string {
	let marker = "";
	if (lastPct !== null) {
		const delta = pct - lastPct;
		if (delta >= ATTRIBUTE_PTS) {
			let topKey = "";
			let topGrowth = 0;
			for (const [key, tokens] of consumers) {
				const growth = tokens - (lastConsumers.get(key) ?? 0);
				if (growth > topGrowth) {
					topGrowth = growth;
					topKey = key;
				}
			}
			marker = topKey ? ` ▲ +${Math.round(delta)}% (${topKey})` : ` ▲ +${Math.round(delta)}%`;
		} else if (delta >= TREND_PTS) marker = " ▲";
	}
	lastPct = pct;
	lastConsumers = consumers;
	return marker;
}

function nudgeOnRed(ctx: ExtensionContext, value: Band): void {
	if (value === "red" && !warnedRed) {
		warnedRed = true;
		ctx.ui.notify(
			"context crossed 40% of the window — consider /merge, /compress, /crop, or /branch (F5.3)",
			"warning",
		);
	}
	if (value !== "red") warnedRed = false;
}

export function refreshAmbient(ctx: ExtensionContext): void {
	let state: ReturnType<typeof deriveState> | undefined;
	try {
		state = deriveState(ctx);
	} catch {}
	const branch = state?.currentFork?.data.name ?? "trunk";
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	const slice = state?.contextEntries;
	const consumers = slice
		? new Map(aggregateConsumers(slice).map((consumer) => [consumer.key, consumer.tokens] as const))
		: undefined;
	let gaugeTokens: number | null = null;
	let pct: number | null = null;
	if (usage && usage.percent !== null && usage.tokens !== null && usage.tokens > 0) {
		gaugeTokens = usage.tokens;
		pct = usage.percent;
	}
	const trend = pct !== null && consumers ? trendMarker(pct, consumers) : "";
	let gaugeText = "ctx —";
	if (pct !== null) {
		const value = band(pct);
		gaugeText = `ctx ${pct.toFixed(1)}% ${value}${trend}`;
		nudgeOnRed(ctx, value);
	} else if (usage) gaugeText = "ctx est…";
	ctx.ui.setStatus("ctree", `⎇ ${branch} · ${gaugeText}`);
	ctx.ui.setTitle(`${basename(ctx.cwd)}${branch !== "trunk" ? ` (${branch})` : ""} (pi)`);
	if (ctx.mode === "tui" && window && window > 0) {
		const gauge = renderGauge({ tokens: gaugeTokens, window, barWidth: 28 }, ctx.ui.theme);
		ctx.ui.setWidget("ctree-gauge", [` ${gauge}${trend}`], { placement: "aboveEditor" });
	}
}

export function registerAmbient(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		resetAmbient();
		refreshAmbient(ctx);
	});
	pi.on("turn_end", (_event, ctx) => refreshAmbient(ctx));
	pi.on("session_tree", (_event, ctx) => refreshAmbient(ctx));
	pi.on("session_before_compact", (_event, ctx) => {
		ctx.ui.notify(
			"heads-up: /compact replaces source material with a lossy summary — pi-context-tree prefers /branch + /merge (decision records), /compress (reviewed range summaries), or /crop. Continuing anyway (F5.4).",
			"warning",
		);
	});
}
