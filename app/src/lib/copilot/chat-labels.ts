import { tNow } from "@/lib/i18n";

/**
 * The chat widget's own words (CopilotKit's defaults are English), in the app's language (#108).
 * A function rather than a constant, so it is read after the language is (a switch reloads).
 */
export function chatLabels() {
  return {
    chatInputPlaceholder: tNow("Type a message..."),
    chatInputToolbarStartTranscribeButtonLabel: tNow("Transcribe"),
    chatInputToolbarCancelTranscribeButtonLabel: tNow("Cancel"),
    chatInputToolbarFinishTranscribeButtonLabel: tNow("Finish"),
    chatInputToolbarAddButtonLabel: tNow("Add attachments"),
    chatInputToolbarToolsButtonLabel: tNow("Tools"),
    assistantMessageToolbarCopyCodeLabel: tNow("Copy"),
    assistantMessageToolbarCopyCodeCopiedLabel: tNow("Copied"),
    assistantMessageToolbarCopyMessageLabel: tNow("Copy"),
    assistantMessageToolbarInspectorLabel: tNow("View in Inspector"),
    assistantMessageToolbarInspectorLocalOnlyLabel: tNow("Development Only"),
    assistantMessageToolbarThumbsUpLabel: tNow("Good response"),
    assistantMessageToolbarThumbsDownLabel: tNow("Bad response"),
    assistantMessageToolbarReadAloudLabel: tNow("Read aloud"),
    assistantMessageToolbarRegenerateLabel: tNow("Regenerate"),
    userMessageToolbarCopyMessageLabel: tNow("Copy"),
    userMessageToolbarEditMessageLabel: tNow("Edit"),
    chatDisclaimerText: tNow(
      "AI can make mistakes. Please verify important information.",
    ),
    chatToggleOpenLabel: tNow("Open chat"),
    chatToggleCloseLabel: tNow("Close chat"),
    modalHeaderTitle: tNow("Chat"),
    welcomeMessageText: tNow("How can I help you today?"),
  };
}
