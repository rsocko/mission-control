---
title: "Houston: Synthetic Voice Strategy"
status: active
created: 2026-08-08
last_reviewed: 2026-08-08
category: design
related:
  - "[Houston AI Identity](houston-ai-identity.md)"
  - "[AI and Agent Architecture](ai-agent-architecture.md)"
  - "[Voice Capture](../proposed/voice-capture.md)"
---

# Houston - Synthetic Voice Strategy

## Decision Summary

Houston should have an original, provider-neutral synthetic voice rather than
imitating a celebrity or fictional character.

1. Start with a dependable stock voice, using Kokoro locally and optionally
   evaluating Cartesia and ElevenLabs for cloud quality and latency.
2. Develop an original Houston persona through voice design or a contracted
   performer whose agreement explicitly covers synthetic speech and digital
   replicas.
3. Keep a local CPU-capable fallback so core spoken responses do not depend on
   a cloud provider.
4. Use a recognizable performer or fictional-character voice only after
   obtaining written authorization from every applicable performer and IP
   rights holder.

Celebrity and character cloning is deliberately deferred. The technical
ability to derive a voice from samples does not grant the right to use that
identity or performance.

## Desired Voice

Houston should sound like a calm, competent flight controller:

- concise, clear, and unflappable;
- professional but warm;
- authoritative without sounding theatrical;
- intelligible at accelerated playback and on small speakers;
- distinct from recognizable performers or franchise characters.

A useful design brief is "warm, dry, unflappable strategic adviser." It must
not direct a model or performer to reproduce a named person's timbre, cadence,
accent, mannerisms, catchphrases, or signature characterization.

## Functional Requirements

The speech layer must support:

- streaming synthesis with low time-to-first-audio;
- cancellation and barge-in when the user begins speaking;
- sentence or semantic-chunk synthesis rather than waiting for a complete LLM
  response;
- pronunciation overrides for names, projects, acronyms, and domain terms;
- caching of stable prompts such as greetings and confirmations;
- configurable local and cloud providers behind one interface;
- a local fallback for network or provider failure;
- explicit provenance for each voice, model, sample, and consent record;
- disclosure that the user is hearing a synthetic voice;
- auditable retention and deletion of reference recordings and speaker
  profiles.

The voice layer should accept text and presentation hints, not provider-specific
model identifiers, from the agent runtime. A provider adapter should translate
the neutral request into SSML, style tags, or API-specific controls.

## Option Matrix

### Local and Self-Hosted

| Option | Cost and license | Operational profile | Recommendation |
|---|---|---|---|
| **Kokoro-82M** | No usage fee; Apache-2.0 code and weights | Small stock-voice model that runs on CPU; not a true voice cloner | Preferred local baseline |
| **Piper (OHF)** | No usage fee; GPL-3.0 engine, with per-voice licenses | Fast ONNX CPU inference and strong Home Assistant history; custom voices require training | Minimal offline fallback; review distribution implications |
| **Qwen3-TTS** | No usage fee; Apache-2.0 | 0.6B and 1.7B variants for cloning, custom voices, and voice design; GPU recommended; approximately 8-12 GB VRAM is a reasonable evaluation target for 0.6B | Preferred self-hosted original-persona candidate |
| **Chatterbox** | No usage fee; MIT | Nano can run on CPU; Turbo targets low-latency English agents; supports prompt-based cloning and includes output watermarking | Strong local shortlist |
| **CosyVoice 3** | No usage fee; Apache-2.0 | Streaming, multilingual, zero-shot cloning; more involved GPU deployment | Production-oriented alternative |
| **OpenVoice V2** | No usage fee; MIT | Clones tone color while accent and emotion largely come from the base TTS model | Useful modular converter, but more engineering |
| **Coqui XTTS-v2** | Code is MPL-2.0; model is noncommercial under CPML | Six-second references and streaming; original project is unmaintained, with a community successor | Private experimentation only; not the preferred new foundation |
| **Fish Speech S2 Pro** | Personal/research use is free; commercial license required | High quality but heavyweight; published latency relies on data-center-class GPUs | Defer |
| **F5-TTS** | MIT code, but official weights are CC-BY-NC | Capable prompt-audio cloning with GPU optimization paths | Research only unless weights and commercial rights change |
| **StyleTTS2** | Mixed practical licensing constraints | Older, training-heavy, and less operationally polished | Defer |

An open-source model license covers the authors' code or weights. It does not
authorize cloning the voice of a celebrity, actor, employee, or other person.

### Cloud Services

Pricing is indicative as of the review date and must be checked before vendor
selection.

| Provider | Approximate cost | Strengths | Constraints |
|---|---:|---|---|
| **ElevenLabs** | Flash/Turbo about $0.05 per 1,000 characters; multilingual models about $0.10 per 1,000 characters | Straightforward REST/SDK streaming, voice design, instant cloning, professional cloning, broad voice ecosystem | Recurring cost, vendor dependency, commercial rights require a paid plan, and cloning requires appropriate rights |
| **Cartesia Sonic** | Roughly $0.03-$0.05 per generated minute at published overage rates | Sub-100 ms advertised latency, persistent WebSocket API, strong interruption support, instant and professional cloning | Professional cloning requires a qualifying plan and additional training credits |
| **Resemble AI** | Enterprise/business pricing | Low-latency streaming and managed cloning; explicit consent practices | Cloning and WebSocket features are business-tier; public generation pricing is not consistently available |
| **PlayHT / PlayAI** | Not currently reliable enough to quote | Streaming and instant-clone APIs have existed | Current availability and pricing must be verified before consideration |
| **Google Cloud TTS** | Region and model dependent | Strong stock Chirp voices and enterprise operations | No currently verified public custom-cloning route |

For a first cloud bake-off, compare Cartesia Sonic and ElevenLabs Flash using
real Houston utterances. Measure first-audio latency, pronunciation, long-form
stability, interruption behavior, emotional consistency, and actual monthly
cost.

## Microsoft Azure Voice Options

Azure AI Speech in Foundry Tools can derive synthetic voices from samples, but
it is not an unrestricted "upload any recording and clone it" service.

| Azure option | Input | Intended use | Access |
|---|---|---|---|
| **Personal Voice** | Approximately one minute of speech plus a required verbal consent statement | Let an application's users replicate their own voices; supports more than 90 languages across more than 100 locales | API access is limited to eligible customers and approved use cases |
| **Custom Voice Lite** | 20-50 Microsoft-provided recording prompts | Moderate-quality demonstration and evaluation in Speech Studio | Evaluation needs no application; application deployment requires full Custom Voice approval |
| **Professional Custom Voice** | 300-2,000 transcript-matched utterances, approximately 30 minutes to 3 hours | High-quality brand or character voice for conversational agents and content | Limited access, use-case review, and recorded voice-talent consent |

Professional Custom Voice training takes approximately 20-40 compute-hours.
The production workflow is:

1. Define the original Houston persona and recording script.
2. Contract and record the performer, preferably in a studio.
3. Submit the performer's prescribed verbal consent statement.
4. Upload paired recordings and transcripts in Speech Studio.
5. Train and evaluate the model against in-domain and out-of-domain scripts.
6. Deploy a custom Speech endpoint.
7. Synthesize through the Speech SDK or REST API, using SSML for pronunciation,
   rate, pitch, and supported speaking styles.

Azure charges separately for training, endpoint hosting, and synthesis by
character. Prices and feature availability vary by region.

Azure Voice Live can provide a real-time conversational pipeline around speech
recognition, model interaction, and synthesis. It does not itself create an
unconsented clone or bypass Custom Voice approval.

### Recommended Azure Path

If Houston remains Azure-centered:

1. Use Custom Voice Lite to evaluate a voice owned by the project.
2. Commission an original performer under an explicit synthetic-voice and
   digital-replica agreement.
3. Apply for Professional Custom Voice access.
4. Train and deploy the production voice.
5. Retain Kokoro or Piper as the offline fallback.

Personal Voice is appropriate when the speaker is the user and the approved
application scenario fits Microsoft's restrictions. It is not the default path
for a shared Houston identity.

## Ready-Made Licensed Voices

Legitimate ready-made recognizable voices exist, but catalog access does not
usually confer unrestricted API or assistant rights.

| Offering | What it provides | Licensing model |
|---|---|---|
| **ElevenLabs Iconic Marketplace** | Curated actor, estate, historical-personality, and character/IP voices | A project proposal is approved or rejected by the talent or rights holder; scope, format, territory, term, and audience are negotiated |
| **ElevenLabs Voice Library** | Platform voices and community-shared professional clones | Uploaders must share their own voice with appropriate rights; this is not a celebrity marketplace |
| **ElevenReader** | Some licensed iconic voices inside the reader application | In-app access does not grant model export, API integration, or reuse in Houston |
| **Respeecher Marketplace** | Professional and some recognizable voices | Voice- and project-specific rights; policy prohibits unauthorized impersonation and false affiliation |
| **Veritone Voice** | Stock and premium recognizable voices | Identity and usage rights must be verified in the voice-specific agreement |
| **Character.AI and community model sites** | Platform-created and user-uploaded voices | A searchable listing is not evidence of consent, export rights, or authorization |

Replica Studios is not an option because the service has shut down.

## Tom Hanks, Peter Dinklage, and Tyrion Lannister

No publicly verified, licensed, reusable TTS or API offering was found for Tom
Hanks, Peter Dinklage, or Tyrion Lannister as of the review date. A private
bespoke agreement might exist, but a community model or character-labelled
voice is not evidence of authorization.

### Tom Hanks

- A Tom Hanks voice requires authorization covering his vocal identity and
  digital replica.
- That authorization would not automatically cover Woody, Forrest Gump, or any
  other character.
- Character use can add studio, franchise, script, trademark, and other IP
  permissions.

### Peter Dinklage and Tyrion Lannister

- A Peter Dinklage voice requires authorization covering Dinklage's vocal
  identity and digital replica.
- Presenting the voice as Tyrion also implicates the relevant HBO/Warner Bros.
  Discovery and Game of Thrones character and franchise rights.
- Permission from Dinklage would not automatically authorize Tyrion.
- Permission to use Tyrion with another performer would not authorize imitation
  of Dinklage.
- A "Tyrion-style" label or impression does not resolve these requirements.

A newly designed "wry fantasy adviser" is safer only when it is not recognizably
imitating Dinklage's performance and avoids Tyrion's name, dialogue, branding,
and distinctive characterization.

## Rights, Consent, and Safety

### Original or Contracted Voice

For every custom voice, retain:

- a recorded consent statement and verified speaker identity;
- source-audio provenance;
- a written license covering model training, generated speech, interactive use,
  platforms, users, territories, duration, compensation, sublicensing,
  revocation, deletion, and commercial use;
- disclosure and watermarking requirements;
- security and retention controls for recordings, embeddings, profiles, and
  model artifacts.

An ordinary voice-over release does not necessarily authorize synthetic
replication. A contracted performer agreement must explicitly cover a digital
replica and open-ended generated dialogue.

### Celebrity or Character Imitation

A voice may not be protected by copyright in isolation, but that does not make
imitation safe. Relevant risks include:

- right-of-publicity and digital-replica laws;
- false endorsement or implied affiliation;
- copyright in copied recordings, scripts, dialogue, music, and effects;
- trademark and character/franchise rights;
- provider acceptable-use and cloning policies;
- fraud, telephony, and disclosure laws when generated speech reaches third
  parties.

Calling a voice a parody, impression, or "inspired by" is not a license. The
combination of timbre, cadence, vocabulary, name, visuals, and branding can
still identify the intended person or character.

SAG-AFTRA digital-replica frameworks emphasize informed consent, a reasonably
specific description of use, compensation, disclosure, and control over reuse.
A provider checkbox or uploader warranty is not a substitute for a
performer-specific agreement.

### Exposure by Use

| Use | Risk posture |
|---|---|
| Private, local experiment | Lower practical exposure, but not automatically lawful or provider-compliant |
| Use inside a consumer platform | Limited to that platform's terms; does not imply export or integration rights |
| Public demo or social video | Material publicity, takedown, affiliation, and trademark exposure |
| Distributed or commercial assistant | Requires explicit digital-replica and, when relevant, character/franchise licenses |

## Delivery Plan

### Phase 1 - Generic Voice

- Integrate a provider-neutral streaming TTS boundary.
- Use Kokoro as the local default and Piper as the minimal fallback.
- Optionally A/B test Cartesia Sonic and ElevenLabs Flash.
- Implement cancellation, barge-in, pronunciation overrides, caching, provider
  health checks, and synthetic-voice disclosure.

### Phase 2 - Original Houston Persona

- Produce a voice brief that does not name a reference performer.
- Evaluate Qwen3-TTS Voice Design, Chatterbox, ElevenLabs Voice Design, and
  Azure Custom Voice Lite.
- Select either a designed voice or a contracted original performer.
- Store consent, license scope, sample provenance, and deletion policy alongside
  the voice configuration.

### Phase 3 - Production Custom Voice

- For Azure, obtain Professional Custom Voice approval and deploy a dedicated
  endpoint.
- Otherwise, deploy the selected self-hosted model or professional cloud clone.
- Benchmark latency, quality, reliability, cost, and fallback behavior under
  realistic conversational load.
- Complete privacy, security, disclosure, and legal review before broad use.

### Phase 4 - Licensed Recognizable Voice

- Consider only when a verified marketplace or direct rights-holder agreement
  specifically approves an interactive assistant.
- Obtain performer/estate rights and separate character or franchise rights
  when applicable.
- Confirm that the synthesis provider permits the arrangement.
- Preserve the original Houston voice as the default and fallback.

## Evaluation Gates

A production candidate must demonstrate:

- acceptable time-to-first-audio and real-time factor on target hardware;
- natural prosody for short acknowledgments and multi-paragraph briefings;
- reliable pronunciation of Mission Control entities;
- clean cancellation without stale queued audio;
- deterministic fallback after provider or network failure;
- bounded monthly cost at expected character volume;
- documented commercial rights for code, model weights, voices, and outputs;
- complete consent, retention, disclosure, and revocation controls.

## References

- [Azure Personal Voice](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-overview)
- [Azure Custom Voice](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-neural-voice)
- [Azure Custom Voice Lite](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-neural-voice-lite)
- [Azure Speech pricing](https://azure.microsoft.com/en-us/pricing/details/speech/)
- [Kokoro](https://github.com/hexgrad/kokoro)
- [Piper](https://github.com/OHF-Voice/piper1-gpl)
- [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
- [Chatterbox](https://github.com/resemble-ai/chatterbox)
- [CosyVoice](https://github.com/FunAudioLLM/CosyVoice)
- [OpenVoice](https://github.com/myshell-ai/OpenVoice)
- [Coqui XTTS-v2 license](https://huggingface.co/coqui/XTTS-v2/blob/main/LICENSE.txt)
- [Fish Speech](https://github.com/fishaudio/fish-speech)
- [F5-TTS](https://github.com/SWivid/F5-TTS)
- [ElevenLabs pricing](https://elevenlabs.io/pricing/api)
- [ElevenLabs voice cloning](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning)
- [ElevenLabs Iconic Marketplace](https://elevenlabs.io/iconic-marketplace)
- [ElevenLabs safety](https://elevenlabs.io/safety)
- [Cartesia models](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest)
- [Cartesia voice cloning](https://docs.cartesia.ai/build-with-cartesia/capability-guides/clone-voices)
- [Respeecher Marketplace](https://www.respeecher.com/marketplace)
- [Respeecher ethics](https://www.respeecher.com/ethics)
- [Veritone Voice](https://www.veritonevoice.com/)
- [SAG-AFTRA 2025 interactive media agreement](https://www.sagaftra.org/sag-aftra-members-approve-2025-video-game-agreement)
- [United States Copyright Office AI initiative](https://www.copyright.gov/ai/)
- [Midler v. Ford Motor Co.](https://law.justia.com/cases/federal/appellate-courts/F2/849/460/37485/)
- [California Civil Code section 3344](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=3344)
- [Lanham Act section 43(a)](https://www.law.cornell.edu/uscode/text/15/1125)

This document records product and engineering guidance, not legal advice.
