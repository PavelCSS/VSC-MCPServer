import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('vscode', async () => {
    const { mockVscode } = await import('../test/helpers/mockVscode');
    return mockVscode;
});

import { zodToJsonSchema, getAllTools } from './index';

describe('zodToJsonSchema', () => {
    it('should keep the real type for optional().default() params', () => {
        const schema = z.object({
            n: z.number().optional().default(5),
            b: z.boolean().optional().default(false),
            s: z.string().default('x'),
            req: z.number(),
        });
        const out = zodToJsonSchema(schema);
        expect(out.properties).toEqual({
            n: { type: 'number' },
            b: { type: 'boolean' },
            s: { type: 'string' },
            req: { type: 'number' },
        });
        expect(out.required).toEqual(['req']);
    });

    it('should advertise the real types of registered tools', () => {
        const props = (name: string) =>
            getAllTools().find((t) => t.name === name)!.inputSchema.properties as Record<
                string,
                { type: string }
            >;
        expect(props('workspace_symbols').maxResults.type).toBe('number');
        expect(props('find_references').includeDeclaration.type).toBe('boolean');
        expect(props('open_folder').newWindow.type).toBe('boolean');
    });
});
