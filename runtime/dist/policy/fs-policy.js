import path from "path";
/**
 * Check if a file path is allowed by the FS policy.
 * Detects path traversal attempts (../) regardless of other rules.
 */
export function isFsPathAllowed(filePath, policy) {
    const normalized = path.normalize(filePath);
    // Detect path traversal
    if (normalized.includes(".."))
        return false;
    if (policy.allowedPaths.length === 0) {
        // workspaceOnly still requires an absolute path within some allowed scope
        return !policy.workspaceOnly || path.isAbsolute(normalized);
    }
    return policy.allowedPaths.some((allowed) => {
        const normalizedAllowed = path.normalize(allowed);
        return normalized.startsWith(normalizedAllowed);
    });
}
export function parseFsPolicyFromAgent(fsAllowedPathsJson) {
    try {
        const paths = JSON.parse(fsAllowedPathsJson);
        return { workspaceOnly: true, allowedPaths: paths };
    }
    catch {
        return { workspaceOnly: true, allowedPaths: [] };
    }
}
