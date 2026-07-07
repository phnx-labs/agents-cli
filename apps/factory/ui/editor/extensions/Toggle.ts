import { Node, mergeAttributes } from '@tiptap/core';

export interface ToggleOptions {
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggle: {
      setToggle: () => ReturnType;
    };
  }
}

export default Node.create<ToggleOptions>({
  name: 'toggle',

  group: 'block',

  content: 'block+',

  defining: true,

  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (element) => element.hasAttribute('open'),
        renderHTML: (attributes) => ({
          open: attributes.open ? '' : null,
        }),
      },
      summary: {
        default: 'Toggle',
        parseHTML: (element) => element.getAttribute('data-summary'),
        renderHTML: (attributes) => ({
          'data-summary': attributes.summary,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'details[data-toggle]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        { 'data-toggle': '' },
        { class: 'notion-toggle' }
      ),
      ['summary', { class: 'notion-toggle-summary' }, HTMLAttributes['data-summary'] || 'Toggle'],
      ['div', { class: 'notion-toggle-content' }, 0],
    ];
  },

  addCommands() {
    return {
      setToggle:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    };
  },
});
