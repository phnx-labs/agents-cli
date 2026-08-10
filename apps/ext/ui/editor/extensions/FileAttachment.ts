import { Node, mergeAttributes } from '@tiptap/core';

export interface FileAttachmentOptions {
  HTMLAttributes: Record<string, any>;
  onSaveAsset: (data: string, fileName: string) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fileAttachment: {
      setFileAttachment: (options: { fileName: string; fileSize: number; src: string }) => ReturnType;
    };
  }
}

export default Node.create<FileAttachmentOptions>({
  name: 'fileAttachment',

  group: 'block',

  atom: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      onSaveAsset: () => {},
    };
  },

  addAttributes() {
    return {
      fileName: {
        default: 'file',
        parseHTML: (element) => element.getAttribute('data-file-name'),
        renderHTML: (attributes) => ({
          'data-file-name': attributes.fileName,
        }),
      },
      fileSize: {
        default: 0,
        parseHTML: (element) => parseInt(element.getAttribute('data-file-size') || '0', 10),
        renderHTML: (attributes) => ({
          'data-file-size': attributes.fileSize,
        }),
      },
      src: {
        default: null,
        parseHTML: (element) => element.getAttribute('href'),
        renderHTML: (attributes) => ({
          href: attributes.src,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'a[data-file-attachment]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const sizeKB = Math.round(HTMLAttributes['data-file-size'] / 1024);
    const sizeText = sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;

    return [
      'div',
      mergeAttributes({ class: 'notion-file-attachment' }),
      [
        'a',
        mergeAttributes(
          this.options.HTMLAttributes,
          {
            href: HTMLAttributes.href,
            'data-file-attachment': '',
            'data-file-name': HTMLAttributes['data-file-name'],
            'data-file-size': HTMLAttributes['data-file-size'],
            class: 'notion-file-link',
            download: HTMLAttributes['data-file-name'],
          }
        ),
        [
          'div',
          { class: 'notion-file-icon' },
          '[FILE]',
        ],
        [
          'div',
          { class: 'notion-file-info' },
          ['div', { class: 'notion-file-name' }, HTMLAttributes['data-file-name'] || 'file'],
          ['div', { class: 'notion-file-size' }, sizeText],
        ],
      ],
    ];
  },

  addCommands() {
    return {
      setFileAttachment:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: options,
          }),
    };
  },
});
