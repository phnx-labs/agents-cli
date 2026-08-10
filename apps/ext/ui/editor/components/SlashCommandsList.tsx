import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';

interface SlashCommandsListProps {
  items: Array<{
    title: string;
    command: (props: any) => void;
  }>;
  command: (props: any) => void;
}

const SlashCommandsList = forwardRef((props: SlashCommandsListProps, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (item) {
      props.command(item);
    }
  };

  const upHandler = () => {
    setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length);
  };

  const downHandler = () => {
    setSelectedIndex((selectedIndex + 1) % props.items.length);
  };

  const enterHandler = () => {
    selectItem(selectedIndex);
  };

  useEffect(() => setSelectedIndex(0), [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === 'ArrowUp') {
        upHandler();
        return true;
      }

      if (event.key === 'ArrowDown') {
        downHandler();
        return true;
      }

      if (event.key === 'Enter') {
        enterHandler();
        return true;
      }

      return false;
    },
  }));

  return (
    <div className="slash-commands-menu">
      {props.items.length ? (
        props.items.map((item, index) => (
          <button
            className={`slash-command-item ${index === selectedIndex ? 'is-selected' : ''}`}
            key={index}
            onClick={() => selectItem(index)}
          >
            {item.title}
          </button>
        ))
      ) : (
        <div className="slash-command-item">No results</div>
      )}
    </div>
  );
});

SlashCommandsList.displayName = 'SlashCommandsList';

export default SlashCommandsList;
