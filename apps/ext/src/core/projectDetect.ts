import { readdir } from 'node:fs/promises';
import { join, basename, relative } from 'node:path';

export interface Project {
    name: string;
    relPath: string;
}

const MARKERS = new Set([
    'package.json',
    'pyproject.toml',
    'go.mod',
    'Cargo.toml',
    'build.gradle'
]);

const IGNORE_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.venv',
    'venv',
    'target',
    '.next'
]);

export async function detectProjects(repoRoot: string): Promise<Project[]> {
    const projects: Project[] = [];
    const defaultProject = { name: basename(repoRoot), relPath: '.' };

    try {
        async function walk(currentDir: string, depth: number) {
            if (depth > 3) return;

            try {
                const entries = await readdir(currentDir, { withFileTypes: true });
                let hasMarker = false;

                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        if (!IGNORE_DIRS.has(entry.name)) {
                            await walk(join(currentDir, entry.name), depth + 1);
                        }
                    } else if (entry.isFile()) {
                        if (MARKERS.has(entry.name)) {
                            hasMarker = true;
                        }
                    }
                }

                if (hasMarker) {
                    const relPath = currentDir === repoRoot ? '.' : relative(repoRoot, currentDir);
                    const name = currentDir === repoRoot ? basename(repoRoot) : basename(currentDir);
                    projects.push({ name, relPath });
                }
            } catch (err) {
                // Ignore read errors for specific directories
            }
        }

        await walk(repoRoot, 0);

        if (projects.length === 0) {
            return [defaultProject];
        }

        return projects;
    } catch (err) {
        return [defaultProject];
    }
}
