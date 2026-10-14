// Caller paths are runtime provenance, not model-supplied policy fields. A symbol
// survives trusted object spreads/count expansion but is not serialized as input.
const LOCATION = Symbol("acceptance-location");

export function withAcceptanceLocation<T extends object>(value: T, location: string): T {
	return { ...value, [LOCATION]: location };
}

export function acceptanceLocation(value: object, fallback = "acceptance.effects"): string {
	return (value as { [LOCATION]?: string })[LOCATION] ?? fallback;
}
