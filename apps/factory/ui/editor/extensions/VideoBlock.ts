import { Node, mergeAttributes } from '@tiptap/core';

export interface VideoBlockOptions {
  HTMLAttributes: Record<string, any>;
  onSaveAsset: (data: string, fileName: string) => void;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    videoBlock: {
      setVideoBlock: (options: { src: string }) => ReturnType;
    };
  }
}

export default Node.create<VideoBlockOptions>({
  name: 'videoBlock',

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
      src: {
        default: null,
        parseHTML: (element) => element.getAttribute('src'),
        renderHTML: (attributes) => ({
          src: attributes.src,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'video[data-video-block]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'video',
      mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        { 'data-video-block': '' },
        { class: 'notion-video-block', controls: '' }
      ),
    ];
  },

  addCommands() {
    return {
      setVideoBlock:
        (options) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: options,
          }),
    };
  },
});
