import type { CollaborationRemoteMedia, WebRtcSignal } from "@/lib/collaboration/types";

type LocalTrackKey = "audio" | "camera" | "screen";

interface LocalTracks {
    audio: MediaStreamTrack | null;
    camera: MediaStreamTrack | null;
    screen: MediaStreamTrack | null;
}

interface PeerEntry {
    pc: RTCPeerConnection;
    senders: Partial<Record<LocalTrackKey, RTCRtpSender>>;
    transceivers: Partial<Record<LocalTrackKey, RTCRtpTransceiver>>;
    makingOffer: boolean;
    closed: boolean;
    pendingIceCandidates: RTCIceCandidateInit[];
    disconnectedTimer: ReturnType<typeof setTimeout> | null;
}

interface WebRtcMeshOptions {
    localUserId: string;
    onSignal: (signal: WebRtcSignal) => Promise<void>;
    onRemoteMedia: (media: CollaborationRemoteMedia) => void;
    onPeerState?: (peerId: string, state: RTCPeerConnectionState) => void;
    onError?: (message: string) => void;
}

function parseIceServers(): RTCIceServer[] {
    const stunCsv = process.env.NEXT_PUBLIC_WEBRTC_STUN_URLS || "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302";
    const turnUrl = process.env.NEXT_PUBLIC_WEBRTC_TURN_URL;
    const turnUsername = process.env.NEXT_PUBLIC_WEBRTC_TURN_USERNAME;
    const turnCredential = process.env.NEXT_PUBLIC_WEBRTC_TURN_CREDENTIAL;

    const servers: RTCIceServer[] = [
        {
            urls: stunCsv
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
        },
    ];

    if (turnUrl && turnUsername && turnCredential) {
        servers.push({
            urls: turnUrl,
            username: turnUsername,
            credential: turnCredential,
        });
    }

    return servers;
}

export class WebRtcMesh {
    private readonly localUserId: string;
    private readonly onSignal: WebRtcMeshOptions["onSignal"];
    private readonly onRemoteMedia: WebRtcMeshOptions["onRemoteMedia"];
    private readonly onPeerState?: WebRtcMeshOptions["onPeerState"];
    private readonly onError?: WebRtcMeshOptions["onError"];

    private readonly peers = new Map<string, PeerEntry>();
    private readonly remoteMediaState = new Map<string, CollaborationRemoteMedia>();
    private readonly localTracks: LocalTracks = {
        audio: null,
        camera: null,
        screen: null,
    };

    constructor(options: WebRtcMeshOptions) {
        this.localUserId = options.localUserId;
        this.onSignal = options.onSignal;
        this.onRemoteMedia = options.onRemoteMedia;
        this.onPeerState = options.onPeerState;
        this.onError = options.onError;
    }

    async connectPeer(remoteUserId: string, shouldInitiate: boolean): Promise<void> {
        if (!remoteUserId || remoteUserId === this.localUserId) return;
        const entry = this.ensurePeer(remoteUserId);

        if (!entry) return;
        await this.syncPeerTracks(remoteUserId, entry);

        if (shouldInitiate && this.isOfferer(remoteUserId)) {
            await this.createAndSendOffer(remoteUserId, entry);
        }
    }

    disconnectPeer(remoteUserId: string): void {
        const entry = this.peers.get(remoteUserId);
        if (!entry) return;
        entry.closed = true;
        if (entry.disconnectedTimer) {
            clearTimeout(entry.disconnectedTimer);
            entry.disconnectedTimer = null;
        }
        entry.pc.close();
        this.peers.delete(remoteUserId);
        const cleared: CollaborationRemoteMedia = {
            userId: remoteUserId,
            cameraStream: null,
            screenStream: null,
            audioStream: null,
        };
        this.remoteMediaState.set(remoteUserId, cleared);
        this.onRemoteMedia(cleared);
    }

    disconnectAll(): void {
        for (const remoteUserId of this.peers.keys()) {
            this.disconnectPeer(remoteUserId);
        }
    }

    getConnectedPeers(): string[] {
        return Array.from(this.peers.keys());
    }

    async updateLocalTracks(nextTracks: Partial<LocalTracks>): Promise<void> {
        if (typeof window === "undefined") return;
        if (Object.prototype.hasOwnProperty.call(nextTracks, "audio")) {
            this.localTracks.audio = nextTracks.audio ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(nextTracks, "camera")) {
            this.localTracks.camera = nextTracks.camera ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(nextTracks, "screen")) {
            this.localTracks.screen = nextTracks.screen ?? null;
        }

        for (const [remoteUserId, entry] of this.peers.entries()) {
            await this.syncPeerTracks(remoteUserId, entry);
            if (this.isOfferer(remoteUserId)) {
                await this.createAndSendOffer(remoteUserId, entry);
            } else {
                await this.emitSignal({
                    from: this.localUserId,
                    to: remoteUserId,
                    type: "renegotiate",
                    createdAt: Date.now(),
                });
            }
        }
    }

    async handleSignal(signal: WebRtcSignal): Promise<void> {
        if (!signal || signal.from === this.localUserId) return;
        const remoteUserId = signal.from;
        const entry = this.ensurePeer(remoteUserId);
        if (!entry) return;

        try {
            switch (signal.type) {
                case "renegotiate": {
                    if (this.isOfferer(remoteUserId)) {
                        await this.createAndSendOffer(remoteUserId, entry);
                    }
                    break;
                }
                case "offer": {
                    if (!signal.sdp) return;
                    await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                    await this.flushPendingIce(entry);
                    await this.syncPeerTracks(remoteUserId, entry);
                    const answer = await entry.pc.createAnswer();
                    await entry.pc.setLocalDescription(answer);
                    await this.emitSignal({
                        from: this.localUserId,
                        to: remoteUserId,
                        type: "answer",
                        sdp: answer,
                        createdAt: Date.now(),
                    });
                    break;
                }
                case "answer": {
                    if (!signal.sdp) return;
                    if (!entry.pc.localDescription) return;
                    await entry.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                    await this.flushPendingIce(entry);
                    break;
                }
                case "ice": {
                    if (!signal.candidate) return;
                    if (entry.pc.remoteDescription) {
                        await entry.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                    } else {
                        entry.pendingIceCandidates.push(signal.candidate);
                    }
                    break;
                }
                default:
                    break;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.onError?.(`WebRTC signal handling failed (${signal.type}): ${message}`);
        }
    }

    private ensurePeer(remoteUserId: string): PeerEntry | null {
        if (typeof window === "undefined") return null;
        const existing = this.peers.get(remoteUserId);
        if (existing && !existing.closed) return existing;

        const pc = new RTCPeerConnection({
            iceServers: parseIceServers(),
            bundlePolicy: "max-bundle",
            rtcpMuxPolicy: "require",
        });

        const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
        const cameraTransceiver = pc.addTransceiver("video", { direction: "sendrecv" });
        const screenTransceiver = pc.addTransceiver("video", { direction: "sendrecv" });
        const audioSender = audioTransceiver.sender;
        const cameraSender = cameraTransceiver.sender;
        const screenSender = screenTransceiver.sender;

        const entry: PeerEntry = {
            pc,
            senders: {
                audio: audioSender,
                camera: cameraSender,
                screen: screenSender,
            },
            transceivers: {
                audio: audioTransceiver,
                camera: cameraTransceiver,
                screen: screenTransceiver,
            },
            makingOffer: false,
            closed: false,
            pendingIceCandidates: [],
            disconnectedTimer: null,
        };

        pc.onicecandidate = (event) => {
            if (!event.candidate) return;
            void this.emitSignal({
                from: this.localUserId,
                to: remoteUserId,
                type: "ice",
                candidate: event.candidate.toJSON(),
                createdAt: Date.now(),
            });
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            this.onPeerState?.(remoteUserId, state);
            if (state === "connected") {
                if (entry.disconnectedTimer) {
                    clearTimeout(entry.disconnectedTimer);
                    entry.disconnectedTimer = null;
                }
                return;
            }

            if (state === "disconnected") {
                if (entry.disconnectedTimer) return;
                entry.disconnectedTimer = setTimeout(() => {
                    if (entry.closed) return;
                    if (entry.pc.connectionState !== "disconnected") {
                        entry.disconnectedTimer = null;
                        return;
                    }
                    this.onRemoteMedia({
                        userId: remoteUserId,
                        cameraStream: null,
                        screenStream: null,
                        audioStream: null,
                    });
                    entry.disconnectedTimer = null;
                }, 6000);
                return;
            }

            if (state === "failed") {
                if (this.isOfferer(remoteUserId)) {
                    void this.createAndSendOffer(remoteUserId, entry);
                } else {
                    void this.emitSignal({
                        from: this.localUserId,
                        to: remoteUserId,
                        type: "renegotiate",
                        createdAt: Date.now(),
                    });
                }
                return;
            }

            if (state === "closed") {
                if (entry.disconnectedTimer) {
                    clearTimeout(entry.disconnectedTimer);
                    entry.disconnectedTimer = null;
                }
                this.onRemoteMedia({
                    userId: remoteUserId,
                    cameraStream: null,
                    screenStream: null,
                    audioStream: null,
                });
            }
        };

        pc.ontrack = (event) => {
            const stream = new MediaStream([event.track]);
            const current = this.remoteMediaState.get(remoteUserId) ?? {
                userId: remoteUserId,
                cameraStream: null,
                screenStream: null,
                audioStream: null,
            };

            if (event.track.kind === "audio") {
                current.audioStream = stream;
            } else {
                const isScreenTrack = event.transceiver === entry.transceivers.screen;
                const isCameraTrack = event.transceiver === entry.transceivers.camera;
                if (isScreenTrack) {
                    current.screenStream = stream;
                } else if (isCameraTrack) {
                    current.cameraStream = stream;
                } else {
                    const label = (event.track.label || "").toLowerCase();
                    const hasScreenHints =
                        label.includes("screen") ||
                        event.track.contentHint === "detail" ||
                        label.includes("window") ||
                        label.includes("display");
                    if (hasScreenHints) current.screenStream = stream;
                    else current.cameraStream = stream;
                }
            }

            this.remoteMediaState.set(remoteUserId, current);
            this.onRemoteMedia(current);

            event.track.onended = () => {
                if (event.track.kind === "audio") {
                    const next = this.remoteMediaState.get(remoteUserId) ?? {
                        userId: remoteUserId,
                        cameraStream: null,
                        screenStream: null,
                        audioStream: null,
                    };
                    next.audioStream = null;
                    this.remoteMediaState.set(remoteUserId, next);
                    this.onRemoteMedia(next);
                    return;
                }

                const isScreenTrack = event.transceiver === entry.transceivers.screen;
                const isCameraTrack = event.transceiver === entry.transceivers.camera;
                const next = this.remoteMediaState.get(remoteUserId) ?? {
                    userId: remoteUserId,
                    cameraStream: null,
                    screenStream: null,
                    audioStream: null,
                };
                if (isScreenTrack) {
                    next.screenStream = null;
                } else if (isCameraTrack) {
                    next.cameraStream = null;
                } else {
                    const label = (event.track.label || "").toLowerCase();
                    const hasScreenHints =
                        label.includes("screen") ||
                        event.track.contentHint === "detail" ||
                        label.includes("window") ||
                        label.includes("display");
                    if (hasScreenHints) next.screenStream = null;
                    else next.cameraStream = null;
                }
                this.remoteMediaState.set(remoteUserId, next);
                this.onRemoteMedia(next);
            };
        };

        pc.onnegotiationneeded = () => {
            const peer = this.peers.get(remoteUserId);
            if (!peer || peer.closed) return;
            if (this.isOfferer(remoteUserId)) {
                void this.createAndSendOffer(remoteUserId, peer);
            } else {
                void this.emitSignal({
                    from: this.localUserId,
                    to: remoteUserId,
                    type: "renegotiate",
                    createdAt: Date.now(),
                });
            }
        };

        this.peers.set(remoteUserId, entry);
        return entry;
    }

    private isOfferer(remoteUserId: string): boolean {
        return this.localUserId.localeCompare(remoteUserId) < 0;
    }

    private async emitSignal(signal: WebRtcSignal): Promise<void> {
        try {
            await this.onSignal(signal);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.onError?.(`Failed to send WebRTC signal: ${message}`);
        }
    }

    private async createAndSendOffer(remoteUserId: string, entry: PeerEntry): Promise<void> {
        if (entry.makingOffer || entry.closed) return;
        if (entry.pc.signalingState !== "stable") return;
        entry.makingOffer = true;
        try {
            await this.syncPeerTracks(remoteUserId, entry);
            const offer = await entry.pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
            });
            await entry.pc.setLocalDescription(offer);
            await this.emitSignal({
                from: this.localUserId,
                to: remoteUserId,
                type: "offer",
                sdp: offer,
                createdAt: Date.now(),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.onError?.(`Failed to negotiate with ${remoteUserId}: ${message}`);
        } finally {
            entry.makingOffer = false;
        }
    }

    private async flushPendingIce(entry: PeerEntry): Promise<void> {
        if (!entry.pc.remoteDescription || entry.pendingIceCandidates.length === 0) return;
        const pending = entry.pendingIceCandidates.splice(0, entry.pendingIceCandidates.length);
        for (const candidate of pending) {
            await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }

    private async syncPeerTracks(remoteUserId: string, entry: PeerEntry): Promise<void> {
        const attachTrack = (key: LocalTrackKey, track: MediaStreamTrack | null) => {
            const sender = entry.senders[key];
            if (!sender) return;

            if (track && key === "screen") {
                track.contentHint = "detail";
            }

            const currentTrackId = sender.track?.id ?? null;
            const nextTrackId = track?.id ?? null;
            if (currentTrackId === nextTrackId) {
                return;
            }

            void sender.replaceTrack(track ?? null);
        };

        attachTrack("audio", this.localTracks.audio);
        attachTrack("camera", this.localTracks.camera);
        attachTrack("screen", this.localTracks.screen);

        if (this.isOfferer(remoteUserId) && entry.pc.signalingState === "stable") {
            const hasTracks =
                Boolean(this.localTracks.audio) ||
                Boolean(this.localTracks.camera) ||
                Boolean(this.localTracks.screen);
            if (!hasTracks) {
                // Keep connection alive even when no local tracks are published.
                return;
            }
        }
    }
}
