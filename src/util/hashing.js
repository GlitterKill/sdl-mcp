import * as crypto from "crypto";
export function hashContent(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}
export function generateSymbolId(repoId, relPath, kind, name, astFingerprint) {
    const combined = `${repoId}:${relPath}:${kind}:${name}:${astFingerprint}`;
    return crypto.createHash("sha256").update(combined).digest("hex");
}
function normalizeObject(obj) {
    if (obj === null || obj === undefined) {
        return null;
    }
    if (Array.isArray(obj)) {
        return obj.map(normalizeObject);
    }
    if (typeof obj === "object" && obj !== null) {
        const normalized = {};
        const sortedKeys = Object.keys(obj).sort();
        for (const key of sortedKeys) {
            const value = obj[key];
            if (value !== undefined) {
                normalized[key] = normalizeObject(value);
            }
        }
        return normalized;
    }
    return obj;
}
export function normalizeCard(card) {
    return normalizeObject(card);
}
export function hashCard(card) {
    const normalized = normalizeCard(card);
    const canonical = JSON.stringify(normalized);
    return hashContent(canonical);
}
//# sourceMappingURL=hashing.js.map