/**
 * Pairing domain module.
 *
 * Pairing binds a Bridge to a single allowed Telegram user. The FIRST user
 * to message the bot becomes the paired user; afterwards only that user is
 * accepted. Single-user by design.
 */

/**
 * The pairing state for a Bridge.
 * pairedUserId is null when no user has paired yet, or a Telegram user ID once paired.
 */
export type PairingState = {
  pairedUserId: number | null;
};

/**
 * The outcome of a pairing decision.
 */
export type PairingDecision =
  | { kind: "pair"; userId: number }    // No one paired yet → this user becomes paired
  | { kind: "accept"; userId: number }  // Message from the already-paired user
  | { kind: "reject"; userId: number }; // Message from a different user

/**
 * Decide what to do with an incoming message from a Telegram user.
 *
 * Pure function: given the current pairing state and an incoming user ID,
 * returns the pairing decision.
 */
export function decidePairing(
  state: PairingState,
  incomingUserId: number,
): PairingDecision {
  if (state.pairedUserId === null) {
    // No one paired yet → pair with this user
    return { kind: "pair", userId: incomingUserId };
  }

  if (incomingUserId === state.pairedUserId) {
    // Message from the already-paired user
    return { kind: "accept", userId: incomingUserId };
  }

  // Message from a different user
  return { kind: "reject", userId: incomingUserId };
}

/**
 * Apply a pairing decision to produce the next state.
 *
 * Pure function: returns a new PairingState based on the decision.
 * Never mutates the input state.
 *
 * - "pair" → returns new state with pairedUserId set
 * - "accept" / "reject" → returns state with same values (may be new object)
 */
export function applyPairing(
  state: PairingState,
  decision: PairingDecision,
): PairingState {
  if (decision.kind === "pair") {
    // Pair this user → return new state with pairedUserId set
    return { pairedUserId: decision.userId };
  }

  // Accept or reject → state unchanged, return new object with same values
  return { pairedUserId: state.pairedUserId };
}
