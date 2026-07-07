import { Extension } from '@tiptap/core';

/**
 * Custom keyboard shortcuts for Notion-like editing experience
 */
export default Extension.create({
  name: 'keyboardShortcuts',

  addKeyboardShortcuts() {
    return {
      // Text formatting
      'Mod-b': () => this.editor.commands.toggleBold(),
      'Mod-i': () => this.editor.commands.toggleItalic(),
      'Mod-e': () => this.editor.commands.toggleCode(),
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),

      // Link handling
      'Mod-k': () => {
        const previousUrl = this.editor.getAttributes('link').href;
        const url = window.prompt('URL', previousUrl);

        if (url === null) {
          return false;
        }

        if (url === '') {
          return this.editor
            .chain()
            .focus()
            .extendMarkRange('link')
            .unsetLink()
            .run();
        }

        return this.editor
          .chain()
          .focus()
          .extendMarkRange('link')
          .setLink({ href: url })
          .run();
      },

      // Heading shortcuts (Notion-style)
      'Mod-Alt-1': () => this.editor.commands.setHeading({ level: 1 }),
      'Mod-Alt-2': () => this.editor.commands.setHeading({ level: 2 }),
      'Mod-Alt-3': () => this.editor.commands.setHeading({ level: 3 }),
      'Mod-Alt-0': () => this.editor.commands.setParagraph(),

      // List shortcuts
      'Mod-Shift-8': () => this.editor.commands.toggleBulletList(),
      'Mod-Shift-7': () => this.editor.commands.toggleOrderedList(),
      'Mod-Shift-9': () => this.editor.commands.toggleTaskList(),

      // Code block
      'Mod-Alt-c': () => this.editor.commands.toggleCodeBlock(),

      // Blockquote
      'Mod-Shift-b': () => this.editor.commands.toggleBlockquote(),

      // Highlight
      'Mod-Shift-h': () => this.editor.commands.toggleHighlight(),

      // Send selection to agent (Cmd+Shift+A)
      'Mod-Shift-a': () => {
        const vscode = (window as any).acquireVsCodeApi?.();
        if (vscode) {
          const selection = this.editor.state.doc.textBetween(
            this.editor.state.selection.from,
            this.editor.state.selection.to,
            ' '
          );
          if (selection) {
            vscode.postMessage({ type: 'sendToAgent', selection });
          }
        }
        return true;
      },

      // AI improve shortcut
      'Mod-Shift-i': () => {
        const vscode = (window as any).acquireVsCodeApi?.();
        if (vscode) {
          const selection = this.editor.state.doc.textBetween(
            this.editor.state.selection.from,
            this.editor.state.selection.to,
            ' '
          );
          if (selection) {
            vscode.postMessage({ type: 'aiAction', action: 'improve', selection });
          }
        }
        return true;
      },
    };
  },
});
