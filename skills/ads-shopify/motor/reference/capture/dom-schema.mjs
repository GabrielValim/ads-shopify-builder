/**
 * Contrato do snapshot de DOM produzido pela captura (dom-<viewport>.json).
 * Validado antes de gravar: um snapshot fora do contrato é falha
 * (CAPTURE_INVALID), nunca um artefato aceito.
 */

import { z } from "zod";

const box = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
});

const counts = z.object({
    images: z.number().int().nonnegative(),
    links: z.number().int().nonnegative(),
    buttons: z.number().int().nonnegative(),
    inputs: z.number().int().nonnegative(),
    headings: z.number().int().nonnegative(),
    textChars: z.number().int().nonnegative(),
});

const node = z.object({
    id: z.number().int().nonnegative(),
    parent: z.number().int().nonnegative().nullable(),
    depth: z.number().int().nonnegative(),
    tag: z.string().min(1),
    role: z.string().nullable(),
    visible: z.boolean(),
    box,
    attrs: z.record(z.string(), z.string()),
    text: z.string(),
    textLength: z.number().int().nonnegative(),
    styles: z.record(z.string(), z.string()),
    headingLevel: z.number().int().min(1).max(6).optional(),
    media: z
        .object({
            kind: z.enum(["img", "video", "svg"]),
            naturalWidth: z.number().nonnegative(),
            naturalHeight: z.number().nonnegative(),
            complete: z.boolean(),
        })
        .optional(),
});

export const domSnapshotSchema = z
    .object({
        schemaVersion: z.literal(1),
        viewport: z.object({
            name: z.string(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            deviceScaleFactor: z.number().positive(),
            isMobile: z.boolean(),
        }),
        document: z.object({
            url: z.string(),
            title: z.string(),
            lang: z.string().nullable(),
            dir: z.string().nullable(),
            viewport: z.object({ width: z.number(), height: z.number() }),
            scroll: z.object({ width: z.number(), height: z.number() }),
            devicePixelRatio: z.number(),
        }),
        stats: z.object({
            totalElements: z.number().int().nonnegative(),
            recordedNodes: z.number().int().nonnegative(),
            truncated: z.boolean(),
            images: z.object({
                total: z.number().int().nonnegative(),
                complete: z.number().int().nonnegative(),
                failed: z.number().int().nonnegative(),
                pending: z.number().int().nonnegative(),
            }),
        }),
        fonts: z.array(
            z.object({ family: z.string(), weight: z.string(), style: z.string(), status: z.string() })
        ),
        sections: z.array(
            z.object({
                nodeId: z.number().int().nonnegative(),
                kind: z.enum(["landmark", "shopify-section", "band"]),
                tag: z.string(),
                role: z.string().nullable(),
                box,
                counts,
                headings: z.array(z.string()),
            })
        ),
        headings: z.array(
            z.object({
                nodeId: z.number().int().nonnegative(),
                level: z.number().int().min(1).max(6),
                text: z.string(),
                fontSize: z.string(),
                fontWeight: z.string(),
                box,
            })
        ),
        fixedElements: z.array(
            z.object({
                nodeId: z.number().int().nonnegative(),
                position: z.enum(["fixed", "sticky"]),
                box,
                overlay: z.boolean(),
            })
        ),
        nodes: z.array(node),
    })
    .strict()
    .superRefine((snapshot, ctx) => {
        snapshot.nodes.forEach((item, index) => {
            if (item.id !== index) {
                ctx.addIssue({ code: "custom", message: `id fora de ordem no nó ${index}` });
            }
            if (item.parent !== null && item.parent >= index) {
                ctx.addIssue({ code: "custom", message: `pai inválido no nó ${index}` });
            }
        });
        for (const ref of [...snapshot.sections, ...snapshot.headings, ...snapshot.fixedElements]) {
            if (ref.nodeId >= snapshot.nodes.length) {
                ctx.addIssue({ code: "custom", message: `referência a nó inexistente ${ref.nodeId}` });
            }
        }
    });

/** @typedef {z.infer<typeof domSnapshotSchema>} DomSnapshot */
