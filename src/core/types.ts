import type { UserMessage } from "@earendil-works/pi-ai";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export type { SessionEntry };
export type MessageEntry = SessionMessageEntry;
export type AgentMessage = SessionMessageEntry["message"];
export type UserContent = UserMessage["content"];

export function isMessageEntry(e: SessionEntry): e is MessageEntry {
	return e.type === "message" && typeof (e as MessageEntry).message === "object";
}

export function isCustomMessageEntry(e: SessionEntry): e is CustomMessageEntry {
	return e.type === "custom_message";
}
