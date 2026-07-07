import { Node, mergeAttributes } from '@tiptap/core';

export interface CalloutOptions {
  HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (type?: 'info' | 'warning' | 'success' | 'error') => ReturnType;
      toggleCallout: (type?: 'info' | 'warning' | 'success' | 'error') => ReturnType;
    };
  }
}

export default Node.create<CalloutOptions>({
  name: 'callout',

  group: 'block',

  content: 'block+',

  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (element) => element.getAttribute('data-type'),
        renderHTML: (attributes) => ({
          'data-type': attributes.type,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-callout]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        { 'data-callout': '' },
        { class: `notion-callout notion-callout-${HTMLAttributes['data-type']}` }
      ),
      ['div', { class: 'notion-callout-icon' }, getCalloutIcon(HTMLAttributes['data-type'])],
      ['div', { class: 'notion-callout-content' }, 0],
    ];
  },

  addCommands() {
    return {
      setCallout:
        (type = 'info') =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type }),
      toggleCallout:
        (type = 'info') =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { type }),
    };
  },
});

function getCalloutIcon(type: string): string {
  switch (type) {
    case 'warning':
      return '[!]';
    case 'error':
      return '[X]';
    case 'success':
      return '[OK]';
    case 'info':
    default:
      return '[i]';
  }
}
