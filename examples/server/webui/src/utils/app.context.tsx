import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  APIMessage,
  CanvasData,
  Conversation,
  Message,
  PendingMessage,
  RAGCodeResponse,
  RAGProductResponse,
  ViewingChat,
} from './types';
import StorageUtils from './storage';
import {
  filterThoughtFromMsgs,
  normalizeMsgsForAPI,
  getSSEStreamAsync,
} from './misc';
import { BASE_URL, CONFIG_DEFAULT, isDev } from '../Config';
import { matchPath, useLocation, useNavigate } from 'react-router';

interface AppContextValue {
  // conversations and messages
  viewingChat: ViewingChat | null;
  pendingMessages: Record<Conversation['id'], PendingMessage>;
  isGenerating: (convId: string) => boolean;
  sendMessage: (
    convId: string | null,
    leafNodeId: Message['id'] | null,
    content: string,
    extra: Message['extra'],
    onChunk: CallbackGeneratedChunk
  ) => Promise<boolean>;
  stopGenerating: (convId: string) => void;
  replaceMessageAndGenerate: (
    convId: string,
    parentNodeId: Message['id'], // the parent node of the message to be replaced
    content: string | null,
    extra: Message['extra'],
    onChunk: CallbackGeneratedChunk
  ) => Promise<void>;

  // canvas
  canvasData: CanvasData | null;
  setCanvasData: (data: CanvasData | null) => void;

  // config
  config: typeof CONFIG_DEFAULT;
  saveConfig: (config: typeof CONFIG_DEFAULT) => void;
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  ragCollections: string[];
}

// this callback is used for scrolling to the bottom of the chat and switching to the last node
export type CallbackGeneratedChunk = (currLeafNodeId?: Message['id']) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AppContext = createContext<AppContextValue>({} as any);

const getViewingChat = async (convId: string): Promise<ViewingChat | null> => {
  const conv = await StorageUtils.getOneConversation(convId);
  if (!conv) return null;
  return {
    conv: conv,
    // all messages from all branches, not filtered by last node
    messages: await StorageUtils.getMessages(convId),
  };
};

export const AppContextProvider = ({
  children,
}: {
  children: React.ReactElement;
}) => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const params = matchPath('/chat/:convId', pathname);
  const convId = params?.params?.convId;

  const [viewingChat, setViewingChat] = useState<ViewingChat | null>(null);
  const [pendingMessages, setPendingMessages] = useState<
    Record<Conversation['id'], PendingMessage>
  >({});
  const [aborts, setAborts] = useState<
    Record<Conversation['id'], AbortController>
  >({});
  const [config, setConfig] = useState(StorageUtils.getConfig());
  const [canvasData, setCanvasData] = useState<CanvasData | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [ragCollections] = useState(['codebase', 'products', 'documentation', 'medical_records case:14338']);

  // handle change when the convId from URL is changed
  useEffect(() => {
    // also reset the canvas data
    setCanvasData(null);
    const handleConversationChange = async (changedConvId: string) => {
      if (changedConvId !== convId) return;
      setViewingChat(await getViewingChat(changedConvId));
    };
    StorageUtils.onConversationChanged(handleConversationChange);
    getViewingChat(convId ?? '').then(setViewingChat);
    return () => {
      StorageUtils.offConversationChanged(handleConversationChange);
    };
  }, [convId]);

  const setPending = (convId: string, pendingMsg: PendingMessage | null) => {
    // if pendingMsg is null, remove the key from the object
    if (!pendingMsg) {
      setPendingMessages((prev) => {
        const newState = { ...prev };
        delete newState[convId];
        return newState;
      });
    } else {
      setPendingMessages((prev) => ({ ...prev, [convId]: pendingMsg }));
    }
  };

  const setAbort = (convId: string, controller: AbortController | null) => {
    if (!controller) {
      setAborts((prev) => {
        const newState = { ...prev };
        delete newState[convId];
        return newState;
      });
    } else {
      setAborts((prev) => ({ ...prev, [convId]: controller }));
    }
  };

  ////////////////////////////////////////////////////////////////////////
  // public functions

  const isGenerating = (convId: string) => !!pendingMessages[convId];

  const generateMessage = async (
    convId: string,
    leafNodeId: Message['id'],
    onChunk: CallbackGeneratedChunk
  ) => {
    if (isGenerating(convId)) return;

    const config = StorageUtils.getConfig();
    const currConversation = await StorageUtils.getOneConversation(convId);

    console.log('currConversation' , currConversation);

    if (!currConversation) {
      throw new Error('Current conversation is not found');
    }

    const currMessages = StorageUtils.filterByLeafNodeId(
      await StorageUtils.getMessages(convId),
      leafNodeId,
      false
    );
    const abortController = new AbortController();
    setAbort(convId, abortController);

    if (!currMessages) {
      throw new Error('Current messages are not found');
    }

    const pendingId = Date.now() + 1;
    let pendingMsg: PendingMessage = {
      id: pendingId,
      convId,
      type: 'text',
      timestamp: pendingId,
      role: 'assistant',
      content: null,
      parent: leafNodeId,
      children: [],
    };
    setPending(convId, pendingMsg);

    try {
      // prepare messages for API
      let messages: APIMessage[] = [
        ...(config.systemMessage.length === 0
          ? []
          : [{ role: 'system', content: config.systemMessage } as APIMessage]),
        ...normalizeMsgsForAPI(currMessages),
      ];
      if (config.excludeThoughtOnReq) {
        messages = filterThoughtFromMsgs(messages);
      }
      if (isDev) console.log({ messages });

      // prepare params
      const params = {
        messages,
        stream: true,
        cache_prompt: true,
        samplers: config.samplers,
        temperature: config.temperature,
        dynatemp_range: config.dynatemp_range,
        dynatemp_exponent: config.dynatemp_exponent,
        top_k: config.top_k,
        top_p: config.top_p,
        min_p: config.min_p,
        typical_p: config.typical_p,
        xtc_probability: config.xtc_probability,
        xtc_threshold: config.xtc_threshold,
        repeat_last_n: config.repeat_last_n,
        repeat_penalty: config.repeat_penalty,
        presence_penalty: config.presence_penalty,
        frequency_penalty: config.frequency_penalty,
        dry_multiplier: config.dry_multiplier,
        dry_base: config.dry_base,
        dry_allowed_length: config.dry_allowed_length,
        dry_penalty_last_n: config.dry_penalty_last_n,
        max_tokens: config.max_tokens,
        timings_per_token: !!config.showTokensPerSecond,
        ...(config.custom.length ? JSON.parse(config.custom) : {}),
      };

      // send request
      const fetchResponse = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {}),
        },
        body: JSON.stringify(params),
        signal: abortController.signal,
      });
      if (fetchResponse.status !== 200) {
        const body = await fetchResponse.json();
        throw new Error(body?.error?.message || 'Unknown error');
      }
      const chunks = getSSEStreamAsync(fetchResponse);
      for await (const chunk of chunks) {
        // const stop = chunk.stop;
        if (chunk.error) {
          throw new Error(chunk.error?.message || 'Unknown error');
        }
        const addedContent = chunk.choices[0].delta.content;
        const lastContent = pendingMsg.content || '';
        if (addedContent) {
          pendingMsg = {
            ...pendingMsg,
            content: lastContent + addedContent,
          };
        }
        const timings = chunk.timings;
        if (timings && config.showTokensPerSecond) {
          // only extract what's really needed, to save some space
          pendingMsg.timings = {
            prompt_n: timings.prompt_n,
            prompt_ms: timings.prompt_ms,
            predicted_n: timings.predicted_n,
            predicted_ms: timings.predicted_ms,
          };
        }
        setPending(convId, pendingMsg);
        onChunk(); // don't need to switch node for pending message
      }
    } catch (err) {
      setPending(convId, null);
      if ((err as Error).name === 'AbortError') {
        // user stopped the generation via stopGeneration() function
        // we can safely ignore this error
      } else {
        console.error(err);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        alert((err as any)?.message ?? 'Unknown error');
        throw err; // rethrow
      }
    }

    if (pendingMsg.content !== null) {
      await StorageUtils.appendMsg(pendingMsg as Message, leafNodeId);
    }
    setPending(convId, null);
    onChunk(pendingId); // trigger scroll to bottom and switch to the last node
  };

  const sendMessage = async (
    convId: string | null,
    leafNodeId: Message['id'] | null,
    content: string,
    extra: Message['extra'],
    onChunk: CallbackGeneratedChunk
  ): Promise<boolean> => {

    console.log('sendMessage', { convId, leafNodeId, content, extra });

    if (isGenerating(convId ?? '') || content.trim().length === 0) return false;

    // Intercept queries starting with '/codebase'
    if (content.startsWith('/codebase')) {
      const newContent = await fetchRAGCodebase(content);
      if (newContent !== false) {
        content = newContent;
      }
    }
    else if (content.startsWith('/products')) {
      const newContent = await fetchRAGProducts(content);
      if (newContent !== false) {
        content = newContent;
      }
    }
    else if (content.startsWith('/documentation')) {
      const newContent = await fetchRAGDocumentation(content);
      if (newContent !== false) {
        content = newContent;
      }
    }
    else if (content.startsWith('/medical_records')) {
      const newContent = await fetchRAGMedRecords(content);
      if (newContent !== false) {
        content = newContent;
      }
    }

    if (convId === null || convId.length === 0 || leafNodeId === null) {
      const conv = await StorageUtils.createConversation(
        content.substring(0, 256)
      );
      convId = conv.id;
      leafNodeId = conv.currNode;
      // if user is creating a new conversation, redirect to the new conversation
      navigate(`/chat/${convId}`);
    }

    const now = Date.now();
    const currMsgId = now;
    StorageUtils.appendMsg(
      {
        id: currMsgId,
        timestamp: now,
        type: 'text',
        convId,
        role: 'user',
        content,
        extra,
        parent: leafNodeId,
        children: [],
      },
      leafNodeId
    );
    onChunk(currMsgId);

    try {
      await generateMessage(convId, currMsgId, onChunk);
      return true;
    } catch (_) {
      // TODO: rollback
    }
    return false;
  };

  const stopGenerating = (convId: string) => {
    setPending(convId, null);
    aborts[convId]?.abort();
  };

  // if content is undefined, we remove last assistant message
  const replaceMessageAndGenerate = async (
    convId: string,
    parentNodeId: Message['id'], // the parent node of the message to be replaced
    content: string | null,
    extra: Message['extra'],
    onChunk: CallbackGeneratedChunk
  ) => {
    if (isGenerating(convId)) return;

    if (content !== null) {
      const now = Date.now();
      const currMsgId = now;
      StorageUtils.appendMsg(
        {
          id: currMsgId,
          timestamp: now,
          type: 'text',
          convId,
          role: 'user',
          content,
          extra,
          parent: parentNodeId,
          children: [],
        },
        parentNodeId
      );
      parentNodeId = currMsgId;
    }
    onChunk(parentNodeId);

    await generateMessage(convId, parentNodeId, onChunk);
  };

  const saveConfig = (config: typeof CONFIG_DEFAULT) => {
    StorageUtils.setConfig(config);
    setConfig(config);
  };

  return (
    <AppContext.Provider
      value={{
        isGenerating,
        viewingChat,
        pendingMessages,
        sendMessage,
        stopGenerating,
        replaceMessageAndGenerate,
        canvasData,
        setCanvasData,
        config,
        saveConfig,
        showSettings,
        setShowSettings,
        ragCollections,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useAppContext = () => useContext(AppContext);

async function fetchRAGCodebase(content: string): Promise<string | false> {
  try {
    const ragResponse = await fetch('http://127.0.0.1:5001/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collection: 'codebase',
        query: content, // Pass the content as the query
        limit: 20,
        where: {
          $or: [
            { repo_name: 'bfg-rest-api' },
            { repo_name: 'bfgapi' },
            { repo_name: 'webapi' },
            { repo_name: 'sfa-web-3' },
          ],
        },
      }),
    });

    if (!ragResponse.ok) {
      throw new Error('Failed to fetch from RAG system');
    }

    const ragData: RAGCodeResponse = await ragResponse.json();

    // The RAG context to be injected into the query
    const allDocsString = ragData.results.documents.flat().join(' ');

    const directive =
      'You are a helpful assistant. The context provided below is automatically fetched and may include technical details such as repository names, file names, component names, class names, and function names. Before answering the user\'s query, carefully review all the provided context and integrate it if it is relevant. If any part of the context is ambiguous or unrelated to the query, ignore it. When referencing code, be as specific as possible by including repository names, file names, components, class names, and functions where applicable. Base your answer primarily on the valid context, and if the context is incomplete, note the ambiguity and only supplement with general knowledge as necessary. Prioritize clarity and precision in your response.';

    return content.replace('/codebase', directive + '\n\n' + allDocsString + '\n\n' + content);
  } catch (error) {
    console.error('Error fetching from RAG system:', error);
    alert('Failed to fetch context from RAG system.');
    return false;
  }
}

async function fetchRAGProducts(content: string): Promise<string | false> {
  try {
    const ragResponse = await fetch('http://127.0.0.1:5001/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collection: 'products',
        query: content, // Pass the content as the query
        limit: 20,
        where: null
      }),
    });

    if (!ragResponse.ok) {
      throw new Error('Failed to fetch from RAG producs system');
    }

    const ragData: RAGProductResponse = await ragResponse.json();

    // The RAG context to be injected into the query
    const allDocsString = ragData.results.documents.flat().join(' ');

    const directive =
      'You are a helpful assistant tasked with selecting items based on the users input. The system has provided a list of 20 items. Your job is to evaluate these items and choose the top 5 that best match the users query. Use the users input to guide your selection, prioritizing relevance and accuracy.';

    return content.replace('/products', directive + '\n\n' + allDocsString + '\n\n' + content);
  } catch (error) {
    console.error('Error fetching from RAG system:', error);
    alert('Failed to fetch context from RAG system.');
    return false;
  }
}

async function fetchRAGDocumentation(content: string): Promise<string | false> {
  try {
    const ragResponse = await fetch('http://127.0.0.1:5001/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collection: 'documentation',
        query: content, // Pass the content as the query
        limit: 20,
        where: null
      }),
    });

    if (!ragResponse.ok) {
      throw new Error('Failed to fetch from RAG producs system');
    }

    const ragData: RAGProductResponse = await ragResponse.json();

    // The RAG context to be injected into the query
    const allDocsString = ragData.results.documents.flat().join(' ');

    const directive =
      'You are a helpful assistant. The system has provided a list documentation snippets. Your job is to evaluate these snippets and use any that are relevant. If a snippet is not relevant to the users query, then ignore it. If a snippet is used then site any particluar metadata about it such as file name, table name, column name.';
    return content.replace('/documentation', directive + '\n\n' + allDocsString + '\n\n' + content);
  } catch (error) {
    console.error('Error fetching from RAG system:', error);
    alert('Failed to fetch context from RAG system.');
    return false;
  }
}

async function fetchRAGMedRecords(content: string): Promise<string | false> {
  try {
    const ragResponse = await fetch('http://127.0.0.1:5001/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        collection: 'medical_records',
        query: content, // Pass the content as the query
        limit: 20,
        where: null
      }),
    });

    if (!ragResponse.ok) {
      throw new Error('Failed to fetch from RAG producs system');
    }

    const ragData: RAGProductResponse = await ragResponse.json();

    // The RAG context to be injected into the query
    const allDocsString = ragData.results.documents.flat().join(' ');

    const directive =
      'You are a medical assistant. Evaluate provided medical record snippets and use only relevant ones. Reformat any dates as needed. Cite metadata (file name, topic, caseId, type) for used snippets. Do not cite the actual snippet name, just file name. Ignore irrelevant snippets.';
    return directive + '\n\n' + allDocsString + '\n\n' + content;
  } catch (error) {
    console.error('Error fetching from RAG system:', error);
    alert('Failed to fetch context from RAG system.');
    return false;
  }
}