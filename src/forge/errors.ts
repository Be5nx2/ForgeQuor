/** A Gate decision that cannot be made: unknown Gate, already decided, or a choice it does not offer. */
export class GateError extends Error {}

/** An operation the Run's current state does not allow, such as abandoning a Run that is already over. */
export class RunStateError extends Error {}

/** Something the human gave is no good (an empty Feedback, a path outside the repository). */
export class InvalidInputError extends Error {}

/** No such Run. */
export class RunNotFoundError extends Error {}

/** No such Asset in that Run, or nothing servable recorded for it. Part of the Forge interface (`assetImage`). */
export class AssetNotFoundError extends Error {}

/** A Team setting the environment holds, so the Team page cannot change it. */
export class SeatLockedError extends Error {}

/** A per-Run seat override naming an unknown seat or Runner, or shaped wrong: refused as the Team page refuses it. */
export class InvalidSeatError extends InvalidInputError {}
