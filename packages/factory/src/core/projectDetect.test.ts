import { expect, test, describe, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProjects } from './projectDetect';

describe('detectProjects', () => {
    let tmpDirs: string[] = [];

    async function createTempDir() {
        const d = await mkdtemp(join(tmpdir(), 'mono-'));
        tmpDirs.push(d);
        return d;
    }

    afterAll(async () => {
        for (const d of tmpDirs) {
            await rm(d, { recursive: true, force: true });
        }
    });

    test('monorepo with ignored dirs', async () => {
        const root = await createTempDir();
        
        await writeFile(join(root, 'package.json'), '{}');
        
        await mkdir(join(root, 'packages', 'a'), { recursive: true });
        await writeFile(join(root, 'packages', 'a', 'package.json'), '{}');
        
        await mkdir(join(root, 'services', 'b'), { recursive: true });
        await writeFile(join(root, 'services', 'b', 'pyproject.toml'), '');
        
        await mkdir(join(root, 'node_modules', 'junk'), { recursive: true });
        await writeFile(join(root, 'node_modules', 'junk', 'package.json'), '{}');

        const projects = await detectProjects(root);
        
        expect(projects).toHaveLength(3);
        
        expect(projects).toContainEqual({
            name: basename(root),
            relPath: '.'
        });
        
        expect(projects).toContainEqual({
            name: 'a',
            relPath: join('packages', 'a')
        });
        
        expect(projects).toContainEqual({
            name: 'b',
            relPath: join('services', 'b')
        });
    });

    test('single-project repo', async () => {
        const root = await createTempDir();
        await writeFile(join(root, 'package.json'), '{}');

        const projects = await detectProjects(root);
        expect(projects).toHaveLength(1);
        expect(projects[0]).toEqual({
            name: basename(root),
            relPath: '.'
        });
    });

    test('empty dir', async () => {
        const root = await createTempDir();

        const projects = await detectProjects(root);
        expect(projects).toHaveLength(1);
        expect(projects[0]).toEqual({
            name: basename(root),
            relPath: '.'
        });
    });
});
