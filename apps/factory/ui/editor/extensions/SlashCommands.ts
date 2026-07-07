import { Extension } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import tippy from 'tippy.js';
import SlashCommandsList from '../components/SlashCommandsList';

export default Extension.create({
  name: 'slashCommands',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        command: ({ editor, range, props }: any) => {
          props.command({ editor, range });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
        items: ({ query }: { query: string }) => {
          return [
            {
              title: 'Heading 1',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run();
              },
            },
            {
              title: 'Heading 2',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run();
              },
            },
            {
              title: 'Heading 3',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run();
              },
            },
            {
              title: 'Bullet List',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).toggleBulletList().run();
              },
            },
            {
              title: 'Numbered List',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).toggleOrderedList().run();
              },
            },
            {
              title: 'Task List',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).toggleTaskList().run();
              },
            },
            {
              title: 'Quote',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).toggleBlockquote().run();
              },
            },
            {
              title: 'Code Block',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
              },
            },
            {
              title: 'Divider',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).setHorizontalRule().run();
              },
            },
            {
              title: 'Table',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3 }).run();
              },
            },
            {
              title: 'Callout',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).setCallout('info').run();
              },
            },
            {
              title: 'Toggle',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).setToggle().run();
              },
            },
            {
              title: 'Image',
              command: ({ editor, range }: any) => {
                const url = window.prompt('Image URL:');
                if (url) {
                  editor.chain().focus().deleteRange(range).setImage({ src: url }).run();
                }
              },
            },
            {
              title: 'Video (YouTube)',
              command: ({ editor, range }: any) => {
                const url = window.prompt('YouTube URL:');
                if (url) {
                  editor.chain().focus().deleteRange(range).setYoutubeVideo({ src: url }).run();
                }
              },
            },
            {
              title: 'Send to Agent',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).run();
                const vscode = (window as any).acquireVsCodeApi?.();
                if (vscode) {
                  // Get entire document content
                  const content = editor.storage.markdown.getMarkdown();
                  vscode.postMessage({ type: 'sendToAgent', selection: content });
                }
              },
            },
            {
              title: 'Ask Agent',
              command: ({ editor, range }: any) => {
                editor.chain().focus().deleteRange(range).run();
                const vscode = (window as any).acquireVsCodeApi?.();
                if (vscode) {
                  vscode.postMessage({ type: 'triggerAgent', action: 'ask' });
                }
              },
            },
          ].filter((item) => item.title.toLowerCase().startsWith(query.toLowerCase()));
        },
        render: () => {
          let component: ReactRenderer;
          let popup: any;

          return {
            onStart: (props: any) => {
              component = new ReactRenderer(SlashCommandsList, {
                props,
                editor: props.editor,
              });

              if (!props.clientRect) {
                return;
              }

              popup = tippy('body', {
                getReferenceClientRect: props.clientRect,
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
              });
            },

            onUpdate(props: any) {
              component.updateProps(props);

              if (!props.clientRect) {
                return;
              }

              popup[0].setProps({
                getReferenceClientRect: props.clientRect,
              });
            },

            onKeyDown(props: any) {
              if (props.event.key === 'Escape') {
                popup[0].hide();
                return true;
              }

              return component.ref?.onKeyDown(props);
            },

            onExit() {
              popup[0].destroy();
              component.destroy();
            },
          };
        },
      }),
    ];
  },
});
