import { useEffect, useMemo, useState } from 'react';
import { CallbackGeneratedChunk, useAppContext } from '../utils/app.context';
import ChatMessage from './ChatMessage';
import { CanvasType, Message, PendingMessage } from '../utils/types';
import { classNames, cleanCurrentUrl, throttle } from '../utils/misc';
import CanvasPyInterpreter from './CanvasPyInterpreter';
import StorageUtils from '../utils/storage';
import { useVSCodeContext } from '../utils/llama-vscode';
import { useChatTextarea, ChatTextareaApi } from './useChatTextarea.ts';

/**
 * A message display is a message node with additional information for rendering.
 * For example, siblings of the message node are stored as their last node (aka leaf node).
 */
export interface MessageDisplay {
  msg: Message | PendingMessage;
  siblingLeafNodeIds: Message['id'][];
  siblingCurrIdx: number;
  isPending?: boolean;
}

/**
 * If the current URL contains "?m=...", prefill the message input with the value.
 * If the current URL contains "?q=...", prefill and SEND the message.
 */
const prefilledMsg = {
  content() {
    const url = new URL(window.location.href);
    return url.searchParams.get('m') ?? url.searchParams.get('q') ?? '';
  },
  shouldSend() {
    const url = new URL(window.location.href);
    return url.searchParams.has('q');
  },
  clear() {
    cleanCurrentUrl(['m', 'q']);
  },
};

function getListMessageDisplay(
  msgs: Readonly<Message[]>,
  leafNodeId: Message['id']
): MessageDisplay[] {
  const currNodes = StorageUtils.filterByLeafNodeId(msgs, leafNodeId, true);
  const res: MessageDisplay[] = [];
  const nodeMap = new Map<Message['id'], Message>();
  for (const msg of msgs) {
    nodeMap.set(msg.id, msg);
  }
  // find leaf node from a message node
  const findLeafNode = (msgId: Message['id']): Message['id'] => {
    let currNode: Message | undefined = nodeMap.get(msgId);
    while (currNode) {
      if (currNode.children.length === 0) break;
      currNode = nodeMap.get(currNode.children.at(-1) ?? -1);
    }
    return currNode?.id ?? -1;
  };
  // traverse the current nodes
  for (const msg of currNodes) {
    const parentNode = nodeMap.get(msg.parent ?? -1);
    if (!parentNode) continue;
    const siblings = parentNode.children;
    if (msg.type !== 'root') {
      res.push({
        msg,
        siblingLeafNodeIds: siblings.map(findLeafNode),
        siblingCurrIdx: siblings.indexOf(msg.id),
      });
    }
  }
  return res;
}

const scrollToBottom = throttle(
  (requiresNearBottom: boolean, delay: number = 80) => {
    const mainScrollElem = document.getElementById('main-scroll');
    if (!mainScrollElem) return;
    const spaceToBottom =
      mainScrollElem.scrollHeight -
      mainScrollElem.scrollTop -
      mainScrollElem.clientHeight;
    if (!requiresNearBottom || spaceToBottom < 50) {
      setTimeout(
        () => mainScrollElem.scrollTo({ top: mainScrollElem.scrollHeight }),
        delay
      );
    }
  },
  80
);

export default function ChatScreen() {
  const {
    viewingChat,
    sendMessage,
    isGenerating,
    stopGenerating,
    pendingMessages,
    canvasData,
    replaceMessageAndGenerate,
    ragCollections
  } = useAppContext();

  const textarea: ChatTextareaApi = useChatTextarea(prefilledMsg.content());

  const { extraContext, clearExtraContext } = useVSCodeContext(textarea);
  // TODO: improve this when we have "upload file" feature
  const currExtra: Message['extra'] = extraContext ? [extraContext] : undefined;

  // keep track of leaf node for rendering
  const [currNodeId, setCurrNodeId] = useState<number>(-1);
  const messages: MessageDisplay[] = useMemo(() => {
    if (!viewingChat) return [];
    else return getListMessageDisplay(viewingChat.messages, currNodeId);
  }, [currNodeId, viewingChat]);

  const currConvId = viewingChat?.conv.id ?? null;
  const pendingMsg: PendingMessage | undefined =
    pendingMessages[currConvId ?? ''];

  useEffect(() => {
    // reset to latest node when conversation changes
    setCurrNodeId(-1);
    // scroll to bottom when conversation changes
    scrollToBottom(false, 1);
  }, [currConvId]);

  const onChunk: CallbackGeneratedChunk = (currLeafNodeId?: Message['id']) => {
    if (currLeafNodeId) {
      setCurrNodeId(currLeafNodeId);
    }
    scrollToBottom(true);
  };

  const sendNewMessage = async () => {
    const lastInpMsg = textarea.value();
    if (lastInpMsg.trim().length === 0 || isGenerating(currConvId ?? ''))
      return;
    textarea.setValue('');
    scrollToBottom(false);
    setCurrNodeId(-1);
    // get the last message node
    const lastMsgNodeId = messages.at(-1)?.msg.id ?? null;
    if (
      !(await sendMessage(
        currConvId,
        lastMsgNodeId,
        lastInpMsg,
        currExtra,
        onChunk
      ))
    ) {
      // restore the input message if failed
      textarea.setValue(lastInpMsg);
    }
    // OK
    clearExtraContext();
  };

  const handleEditMessage = async (msg: Message, content: string) => {
    if (!viewingChat) return;
    setCurrNodeId(msg.id);
    scrollToBottom(false);
    await replaceMessageAndGenerate(
      viewingChat.conv.id,
      msg.parent,
      content,
      msg.extra,
      onChunk
    );
    setCurrNodeId(-1);
    scrollToBottom(false);
  };

  const handleRegenerateMessage = async (msg: Message) => {
    if (!viewingChat) return;
    setCurrNodeId(msg.parent);
    scrollToBottom(false);
    await replaceMessageAndGenerate(
      viewingChat.conv.id,
      msg.parent,
      null,
      msg.extra,
      onChunk
    );
    setCurrNodeId(-1);
    scrollToBottom(false);
  };

  const hasCanvas = !!canvasData;

  useEffect(() => {
    if (prefilledMsg.shouldSend()) {
      // send the prefilled message if needed
      sendNewMessage();
    } else {
      // otherwise, focus on the input
      textarea.focus();
    }
    prefilledMsg.clear();
    // no need to keep track of sendNewMessage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textarea.ref]);

  // due to some timing issues of StorageUtils.appendMsg(), we need to make sure the pendingMsg is not duplicated upon rendering (i.e. appears once in the saved conversation and once in the pendingMsg)
  const pendingMsgDisplay: MessageDisplay[] =
    pendingMsg && messages.at(-1)?.msg.id !== pendingMsg.id
      ? [
          {
            msg: pendingMsg,
            siblingLeafNodeIds: [],
            siblingCurrIdx: 0,
            isPending: true,
          },
        ]
      : [];

  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownOptions] = useState([...ragCollections]);
  const [filteredOptions, setFilteredOptions] = useState<string[]>([]);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0);

  const handleTextareaKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    const value = textarea.value();
    if (e.key === '/') {
      setShowDropdown(true);
      setFilteredOptions(dropdownOptions);
      setHighlightedIndex(0); // Reset highlight to the first option
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (showDropdown && filteredOptions.length > 0) {
        // Select the highlighted option
        handleOptionClick(filteredOptions[highlightedIndex]);
      } else {
        sendNewMessage();
      }
      setShowDropdown(false);
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
    } else if (e.key === 'ArrowDown' && showDropdown) {
      e.preventDefault();
      setHighlightedIndex((prevIndex) =>
        Math.min(prevIndex + 1, filteredOptions.length - 1)
      );
    } else if (e.key === 'ArrowUp' && showDropdown) {
      e.preventDefault();
      setHighlightedIndex((prevIndex) => Math.max(prevIndex - 1, 0));
    } else {
      // Filter dropdown options based on input
      const lastWord = value.split(' ').pop() ?? '';
      if (lastWord.startsWith('/')) {
        const query = lastWord.slice(1).toLowerCase();
        const newFilteredOptions = dropdownOptions.filter((option) =>
          option.toLowerCase().startsWith(query)
        );
        setFilteredOptions(newFilteredOptions);
        setHighlightedIndex(0); // Reset highlight when filtering
      } else {
        setShowDropdown(false);
      }
    }
  };

  const handleOptionClick = (option: string) => {
    const value = textarea.value();
    const lastWord = value.split(' ').pop() ?? '';
    const newValue =
      value.slice(0, value.length - lastWord.length) + `/${option} `;
    textarea.setValue(newValue);
    setShowDropdown(false);
    textarea.focus();
  };

  return (
    <div
      className={classNames({
        'grid lg:gap-8 grow transition-[300ms]': true,
        'grid-cols-[1fr_0fr] lg:grid-cols-[1fr_1fr]': hasCanvas, // adapted for mobile
        'grid-cols-[1fr_0fr]': !hasCanvas,
      })}
    >
      <div
        className={classNames({
          'flex flex-col w-full max-w-[900px] mx-auto': true,
          'hidden lg:flex': hasCanvas, // adapted for mobile
          flex: !hasCanvas,
        })}
      >
        {/* chat messages */}
        <div id="messages-list" className="grow">
          <div className="mt-auto flex justify-center">
            {/* placeholder to shift the message to the bottom */}
            {viewingChat ? '' : 'Send a message to start'}
          </div>
          {[...messages, ...pendingMsgDisplay].map((msg) => (
            <ChatMessage
              key={msg.msg.id}
              msg={msg.msg}
              siblingLeafNodeIds={msg.siblingLeafNodeIds}
              siblingCurrIdx={msg.siblingCurrIdx}
              onRegenerateMessage={handleRegenerateMessage}
              onEditMessage={handleEditMessage}
              onChangeSibling={setCurrNodeId}
            />
          ))}
        </div>

        {/* chat input */}
        <div className="flex flex-row items-end pt-8 pb-6 sticky bottom-0 bg-base-100">
          {showDropdown && (
            <div
              className="absolute bottom-full mb-2 border border-gray-300 rounded shadow-lg z-10"
              style={{ backgroundColor: '#f0f0f0', color: '#000000' }} // Slightly grey background and black text
            >
              {filteredOptions.map((option, index) => (
                <div
                  key={option}
                  className={`px-4 py-2 cursor-pointer hover:bg-gray-200 ${
                    index === highlightedIndex ? 'bg-gray-300' : ''
                  }`}
                  onClick={() => handleOptionClick(option)}
                >
                  {option}
                </div>
              ))}
            </div>
          )}
          <textarea
            // Default (mobile): Enable vertical resize, overflow auto for scrolling if needed
            // Large screens (lg:): Disable manual resize, apply max-height for autosize limit
            className="textarea textarea-bordered w-full resize-vertical lg:resize-none lg:max-h-48 lg:overflow-y-auto" // Adjust lg:max-h-48 as needed (e.g., lg:max-h-60)
            placeholder="Type a message (Shift+Enter to add a new line)"
            ref={textarea.ref}
            onKeyDown={handleTextareaKeyDown}
            id="msg-input"
            dir="auto"
            // Set a base height of 2 rows for mobile views
            // On lg+ screens, the hook will calculate and set the initial height anyway
            rows={2}
          ></textarea>

          {isGenerating(currConvId ?? '') ? (
            <button
              className="btn btn-neutral ml-2"
              onClick={() => stopGenerating(currConvId ?? '')}
            >
              Stop
            </button>
          ) : (
            <button className="btn btn-primary ml-2" onClick={sendNewMessage}>
              Send
            </button>
          )}
        </div>
      </div>
      <div className="w-full sticky top-[7em] h-[calc(100vh-9em)]">
        {canvasData?.type === CanvasType.PY_INTERPRETER && (
          <CanvasPyInterpreter />
        )}
      </div>
    </div>
  );
}
