// T-31 settings P1: typed-reply speech ("Đọc to câu trả lời khi tắt mic", Workflow tab).
// A message the owner TYPES arrives with the microphone OFF; the setting (default ON) decides whether Zumi speaks
// the reply to a typed message. A turn that comes from the microphone (micOn) is always spoken, so the switch can
// never mute a spoken conversation -- it only silences typed replies. There is no microphone in this build yet, so
// every turn is typed and micOn is false; the parameter is threaded through for the mic work in 0.2.4.
export function shouldSpeakReply({ micOn = false, speakTypedWhenMicOff = true } = {}) {
  if (micOn) return true;
  return speakTypedWhenMicOff !== false; // unset / null -> ON
}
