/**
 * The shape of a board template, and the templates that ship with the app.
 * Pure — no database — so the built-ins are checked by a unit test.
 */
import { z } from 'zod';
import { LABEL_COLORS } from '../../components/label-colors';

const category = z.enum(['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE']).nullable();

export const templateStructure = z.object({
  columns: z
    .array(z.object({ name: z.string().min(1).max(80), category, wipLimit: z.number().int().min(1).max(999).nullable().default(null) }))
    .min(1)
    .max(20),
  labels: z.array(z.object({ name: z.string().min(1).max(40), color: z.enum(LABEL_COLORS) })).max(30).default([]),
  cards: z
    .array(
      z.object({
        title: z.string().min(1).max(255),
        /** Index into `columns`. */
        column: z.number().int().min(0),
        labels: z.array(z.string()).max(10).default([]),
        checklist: z.array(z.string().min(1).max(500)).max(50).default([]),
        estimateMinutes: z.number().int().min(5).max(10_080).optional(),
      }),
    )
    .max(200)
    .default([]),
});

export type TemplateStructure = z.infer<typeof templateStructure>;

export interface BuiltIn {
  key: string;
  name: string;
  description: string;
  structure: TemplateStructure;
}

export const BUILT_IN_TEMPLATES: BuiltIn[] = [
  {
    key: 'simple',
    name: 'Simple',
    description: 'Backlog, To do, Doing, Done. Start here if unsure.',
    structure: {
      columns: [
        { name: 'Backlog', category: 'BACKLOG', wipLimit: null },
        { name: 'To do', category: 'TODO', wipLimit: null },
        { name: 'Doing', category: 'IN_PROGRESS', wipLimit: null },
        { name: 'Done', category: 'DONE', wipLimit: null },
      ],
      labels: [],
      cards: [],
    },
  },
  {
    key: 'client',
    name: 'Client project',
    description: 'With a column for work waiting on the client, and a kick-off checklist.',
    structure: {
      columns: [
        { name: 'Backlog', category: 'BACKLOG', wipLimit: null },
        { name: 'To do', category: 'TODO', wipLimit: null },
        { name: 'Doing', category: 'IN_PROGRESS', wipLimit: 3 },
        { name: 'Waiting on client', category: null, wipLimit: null },
        { name: 'Review', category: 'IN_PROGRESS', wipLimit: null },
        { name: 'Done', category: 'DONE', wipLimit: null },
      ],
      labels: [
        { name: 'client', color: 'sky' },
        { name: 'urgent', color: 'rose' },
        { name: 'quick win', color: 'green' },
      ],
      cards: [
        {
          title: 'Kick-off call',
          column: 1,
          labels: ['client'],
          checklist: ['Agree the scope', 'Agree the deadline', 'Swap contact details', 'Write up and send notes'],
          estimateMinutes: 60,
        },
        { title: 'Send the proposal', column: 0, labels: ['client'], checklist: [], estimateMinutes: 90 },
      ],
    },
  },
  {
    key: 'content',
    name: 'Content pipeline',
    description: 'Ideas through drafting and editing to published.',
    structure: {
      columns: [
        { name: 'Ideas', category: 'BACKLOG', wipLimit: null },
        { name: 'Drafting', category: 'IN_PROGRESS', wipLimit: 2 },
        { name: 'Editing', category: 'IN_PROGRESS', wipLimit: null },
        { name: 'Ready to publish', category: 'TODO', wipLimit: null },
        { name: 'Published', category: 'DONE', wipLimit: null },
      ],
      labels: [
        { name: 'blog', color: 'indigo' },
        { name: 'video', color: 'purple' },
        { name: 'social', color: 'amber' },
      ],
      cards: [],
    },
  },
  {
    key: 'life-admin',
    name: 'Life admin',
    description: 'Bills, appointments and the jobs that never feel urgent until they are.',
    structure: {
      columns: [
        { name: 'To sort', category: 'BACKLOG', wipLimit: null },
        { name: 'This week', category: 'TODO', wipLimit: 5 },
        { name: 'Doing', category: 'IN_PROGRESS', wipLimit: null },
        { name: 'Done', category: 'DONE', wipLimit: null },
      ],
      labels: [
        { name: 'home', color: 'teal' },
        { name: 'money', color: 'green' },
        { name: 'health', color: 'rose' },
      ],
      cards: [],
    },
  },
  {
    key: 'sprint',
    name: 'Software sprint',
    description: 'A review column and a work-in-progress limit on Doing.',
    structure: {
      columns: [
        { name: 'Backlog', category: 'BACKLOG', wipLimit: null },
        { name: 'To do', category: 'TODO', wipLimit: null },
        { name: 'In progress', category: 'IN_PROGRESS', wipLimit: 3 },
        { name: 'Review', category: 'IN_PROGRESS', wipLimit: null },
        { name: 'Done', category: 'DONE', wipLimit: null },
      ],
      labels: [
        { name: 'bug', color: 'rose' },
        { name: 'feature', color: 'indigo' },
        { name: 'chore', color: 'slate' },
      ],
      cards: [],
    },
  },
];
