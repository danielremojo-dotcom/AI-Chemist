(() => {
    "use strict";

    /* ---------- Config ---------- */

    const STORAGE_KEY = "ai-chemist-history-v1";
    const MAX_HISTORY = 8;              // keep in sync with MAX_HISTORY_MESSAGES in app.py
    const REQUEST_TIMEOUT_MS = 60000;
    const MAX_INPUT_HEIGHT = 160;

    const WELCOME =
        "Hi! I'm AI-Chemist. Ask me anything about General Chemistry.";

    const STARTERS = [
        "Balance: Fe + O2 -> Fe2O3",
        "Explain molarity with an example",
        "What is Le Chatelier's principle?",
        "How do I find limiting reagents?"
    ];

    /* ---------- Elements ---------- */

    const form = document.getElementById("chat-form");
    const input = document.getElementById("message");
    const chat = document.getElementById("chat");
    const status = document.getElementById("status");
    const sendButton = document.getElementById("send");
    const newChatButton = document.getElementById("new-chat");

    /* ---------- State ---------- */

    let history = loadHistory();
    let busy = false;

    function loadHistory() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];

            return Array.isArray(parsed)
                ? parsed.filter(
                      (m) =>
                          m &&
                          (m.role === "user" || m.role === "assistant") &&
                          typeof m.content === "string"
                  )
                : [];
        } catch {
            return [];
        }
    }

    function saveHistory() {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(history.slice(-MAX_HISTORY * 2))
            );
        } catch {
            /* storage full or blocked: ignore */
        }
    }

    /* ---------- Markdown + math ---------- */

    const MATH_RE =
        /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;

    function escapeHtml(text) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    function renderMath(tex, display) {
        try {
            return window.katex.renderToString(tex, {
                displayMode: display,
                throwOnError: false,
                output: "htmlAndMathml"
            });
        } catch {
            return escapeHtml(tex);
        }
    }

    function renderMarkdown(text) {
        if (!window.marked || !window.DOMPurify) {
            return escapeHtml(text).replace(/\n/g, "<br>");
        }

        const math = [];

        const protectedText = window.katex
            ? text.replace(MATH_RE, (_, a, b, c, d) => {
                  const display = a !== undefined || b !== undefined;
                  const tex = (a ?? b ?? c ?? d).trim();

                  math.push({ tex, display });
                  return `%%MATH${math.length - 1}%%`;
              })
            : text;

        const html = window.marked.parse(protectedText, {
            gfm: true,
            breaks: true
        });

        const clean = window.DOMPurify.sanitize(html, {
            ADD_ATTR: ["target", "rel"]
        });

        return clean.replace(/%%MATH(\d+)%%/g, (_, i) => {
            const item = math[Number(i)];
            return item ? renderMath(item.tex, item.display) : "";
        });
    }

    function makeLinksSafe(root) {
        root.querySelectorAll("a[href]").forEach((a) => {
            a.target = "_blank";
            a.rel = "noopener noreferrer";
        });
    }

    /* ---------- Scrolling ---------- */

    function isNearBottom(threshold = 100) {
        return (
            chat.scrollHeight - chat.scrollTop - chat.clientHeight < threshold
        );
    }

    function scrollToBottom() {
        chat.scrollTop = chat.scrollHeight;
    }

    /* ---------- Message builders ---------- */

    function addUserMessage(text) {
        const message = document.createElement("div");

        message.className = "message user";
        message.textContent = text;

        chat.appendChild(message);
        scrollToBottom();

        return message;
    }

    function createBotMessage() {
        const message = document.createElement("div");
        const content = document.createElement("div");

        message.className = "message bot";
        content.className = "content";

        message.appendChild(content);
        chat.appendChild(message);

        return { message, content };
    }

    function addActions(message, rawText) {
        const actions = document.createElement("div");
        const copy = document.createElement("button");

        actions.className = "actions";

        copy.type = "button";
        copy.className = "copy-btn";
        copy.textContent = "Copy";
        copy.setAttribute("aria-label", "Copy reply to clipboard");

        copy.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(rawText);
                copy.textContent = "Copied";
            } catch {
                copy.textContent = "Couldn't copy";
            }

            setTimeout(() => (copy.textContent = "Copy"), 1500);
        });

        actions.appendChild(copy);
        message.appendChild(actions);
    }

    function finalizeBotMessage(message, content, text) {
        content.classList.remove("typing");
        content.innerHTML = renderMarkdown(text);
        makeLinksSafe(content);
        addActions(message, text);
    }

    function addBotMessage(text) {
        const { message, content } = createBotMessage();

        finalizeBotMessage(message, content, text);

        return message;
    }

    function addErrorMessage(text) {
        const message = document.createElement("div");

        message.className = "message bot error";
        message.setAttribute("role", "alert");
        message.textContent = text;

        chat.appendChild(message);
        scrollToBottom();

        return message;
    }

    function addThinkingMessage() {
        const message = document.createElement("div");

        message.className = "message bot thinking";
        message.setAttribute("aria-label", "AI-Chemist is thinking");
        message.innerHTML = "<span></span><span></span><span></span>";

        chat.appendChild(message);
        scrollToBottom();

        return message;
    }

    /* ---------- Welcome + starters ---------- */

    function addWelcome() {
        const message = document.createElement("div");
        const content = document.createElement("div");
        const starters = document.createElement("div");

        message.className = "message bot welcome";
        content.className = "content";
        content.textContent = WELCOME;

        starters.className = "starters";

        STARTERS.forEach((label) => {
            const chip = document.createElement("button");

            chip.type = "button";
            chip.className = "chip";
            chip.textContent = label;

            chip.addEventListener("click", () => {
                if (busy) return;
                sendMessage(label);
            });

            starters.appendChild(chip);
        });

        message.append(content, starters);
        chat.appendChild(message);
    }

    function removeStarters() {
        chat.querySelectorAll(".starters").forEach((el) => el.remove());
    }

    /* ---------- Server (streaming) ---------- */

    // Sends the question and reads the reply as it arrives.
    // onChunk(fullTextSoFar) is called every time new text comes in.
    async function askServer(message, onChunk) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch("/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    message,
                    history: history.slice(-MAX_HISTORY)
                })
            });

            if (!response.ok) {
                let data = null;

                try {
                    data = await response.json();
                } catch {
                    /* not JSON */
                }

                throw new Error(
                    (data && data.error) ||
                        `Request failed (${response.status}).`
                );
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let full = "";

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                full += decoder.decode(value, { stream: true });
                onChunk(full);
            }

            full += decoder.decode();

            if (!full.trim()) {
                throw new Error("The tutor sent an empty reply.");
            }

            return full;
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error("The request timed out. Please try again.");
            }

            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    /* ---------- Sending ---------- */

    function setBusy(value) {
        busy = value;
        input.disabled = value;
        sendButton.disabled = value;
        chat.setAttribute("aria-busy", String(value));
    }

    async function sendMessage(text) {
        const message = text.trim();

        if (!message || busy) return;

        removeStarters();
        const userBubble = addUserMessage(message);

        input.value = "";
        autoResize();
        setBusy(true);

        const thinking = addThinkingMessage();

        let bubble = null;
        let content = null;
        let latest = "";
        let queued = false;

        try {
            const reply = await askServer(message, (partial) => {
                latest = partial;

                // First text arrived: swap the dots for the real bubble.
                if (!bubble) {
                    thinking.remove();
                    ({ message: bubble, content } = createBotMessage());
                }

                // Redraw at most once per animation frame.
                if (queued) return;
                queued = true;

                requestAnimationFrame(() => {
                    queued = false;

                    const stick = isNearBottom();

                    content.innerHTML = renderMarkdown(latest);

                    if (stick) scrollToBottom();
                });
            });

            history.push({ role: "user", content: message });
            history.push({ role: "assistant", content: reply });
            saveHistory();

            finalizeBotMessage(bubble, content, reply);
            scrollToBottom();

            status.textContent = `AI-Chemist: ${reply}`;
        } catch (error) {
            console.error(error);

            thinking.remove();
            if (bubble) bubble.remove();
            userBubble.remove();

            // Put the question back so the student can resend it.
            input.value = message;
            autoResize();

            addErrorMessage(
                error.message && error.message.length < 140
                    ? `Sorry, something went wrong. ${error.message}`
                    : "Sorry, something went wrong. Please try again."
            );
        } finally {
            setBusy(false);
            input.focus();
        }
    }

    /* ---------- Input behaviour ---------- */

    function autoResize() {
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`;
    }

    input.addEventListener("input", autoResize);

    // Enter sends, Shift+Enter makes a new line.
    input.addEventListener("keydown", (event) => {
        if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.isComposing
        ) {
            event.preventDefault();
            form.requestSubmit();
        }
    });

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        sendMessage(input.value);
    });

    /* ---------- New chat ---------- */

    newChatButton.addEventListener("click", () => {
        if (busy) return;

        history = [];
        saveHistory();

        chat.innerHTML = "";
        status.textContent = "";

        addWelcome();
        input.focus();
    });

    /* ---------- Init ---------- */

    function restoreChat() {
        addWelcome();

        if (!history.length) return;

        removeStarters();

        history.forEach((item) => {
            if (item.role === "user") {
                const bubble = document.createElement("div");

                bubble.className = "message user";
                bubble.textContent = item.content;
                chat.appendChild(bubble);
            } else {
                addBotMessage(item.content);
            }
        });

        scrollToBottom();
    }

    // Wait for the CDN scripts (marked, DOMPurify, KaTeX) to finish loading.
    window.addEventListener("load", () => {
        restoreChat();
        autoResize();
        input.focus();
    });
})();
