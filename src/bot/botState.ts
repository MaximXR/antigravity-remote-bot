
export const telegramSentPrompts = new Set<string>();
export const userStopRequestedChannels = new Set<string>();
export const statusWindowPathCache = new Map<string, string>();
export const restoreWindowPathCache = new Map<string, string>();
export const promptSelectionSentChannels = new Set<string>();
export const lastChoicesCache = new Map<string, string[]>();

/** Channels where the user is expected to type plan edit instructions */
export const planEditPendingChannels = new Map<string, { projectName: string }>();
/** Cached plan content pages per channel */
export const planContentCache = new Map<string, string[]>();

/** Cached artifact content pages per channel and filename key */
export const artifactContentCache = new Map<string, string[]>();

/** Channels where the user is expected to type custom text answers for interactive questions */
export const questionPendingChannels = new Map<string, { projectName: string; optionIndex: number }>();

