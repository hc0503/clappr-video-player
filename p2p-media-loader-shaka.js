require=(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/**
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

if (!window.p2pml) {
    window.p2pml = {};
}

window.p2pml.shaka = require("p2p-media-loader-shaka");

},{"p2p-media-loader-shaka":"p2p-media-loader-shaka"}],2:[function(require,module,exports){
"use strict";
/**
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const p2p_media_loader_core_1 = require("p2p-media-loader-core");
const segment_manager_1 = require("./segment-manager");
const integration = require("./integration");
class Engine extends events_1.EventEmitter {
    constructor(settings = {}) {
        super();
        this.loader = new p2p_media_loader_core_1.HybridLoader(settings.loader);
        this.segmentManager = new segment_manager_1.SegmentManager(this.loader, settings.segments);
        Object.keys(p2p_media_loader_core_1.Events)
            .map(eventKey => p2p_media_loader_core_1.Events[eventKey])
            .forEach(event => this.loader.on(event, (...args) => this.emit(event, ...args)));
    }
    static isSupported() {
        return p2p_media_loader_core_1.HybridLoader.isSupported();
    }
    async destroy() {
        await this.segmentManager.destroy();
    }
    getSettings() {
        return {
            segments: this.segmentManager.getSettings(),
            loader: this.loader.getSettings()
        };
    }
    getDetails() {
        return {
            loader: this.loader.getDetails()
        };
    }
    initShakaPlayer(player) {
        integration.initShakaPlayer(player, this.segmentManager);
    }
}
exports.Engine = Engine;

},{"./integration":3,"./segment-manager":6,"events":"events","p2p-media-loader-core":"p2p-media-loader-core"}],3:[function(require,module,exports){
"use strict";
/**
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const Debug = require("debug");
const manifest_parser_proxy_1 = require("./manifest-parser-proxy");
const utils_1 = require("./utils");
const debug = Debug("p2pml:shaka:index");
function initShakaPlayer(player, segmentManager) {
    registerParserProxies();
    initializeNetworkingEngine();
    let intervalId = 0;
    let lastPlayheadTimeReported = 0;
    player.addEventListener("loading", async () => {
        if (intervalId > 0) {
            clearInterval(intervalId);
            intervalId = 0;
        }
        lastPlayheadTimeReported = 0;
        const manifest = player.getManifest();
        if (manifest && manifest.p2pml) {
            manifest.p2pml.parser.reset();
        }
        await segmentManager.destroy();
        intervalId = setInterval(() => {
            const time = getPlayheadTime(player);
            if (time !== lastPlayheadTimeReported || player.isBuffering()) {
                segmentManager.setPlayheadTime(time);
                lastPlayheadTimeReported = time;
            }
        }, 500);
    });
    debug("register request filter");
    player.getNetworkingEngine().registerRequestFilter((requestType, request) => {
        request.p2pml = { player, segmentManager };
    });
}
exports.initShakaPlayer = initShakaPlayer;
function registerParserProxies() {
    debug("register parser proxies");
    shaka.media.ManifestParser.registerParserByExtension("mpd", manifest_parser_proxy_1.ShakaDashManifestParserProxy);
    shaka.media.ManifestParser.registerParserByMime("application/dash+xml", manifest_parser_proxy_1.ShakaDashManifestParserProxy);
    shaka.media.ManifestParser.registerParserByExtension("m3u8", manifest_parser_proxy_1.ShakaHlsManifestParserProxy);
    shaka.media.ManifestParser.registerParserByMime("application/x-mpegurl", manifest_parser_proxy_1.ShakaHlsManifestParserProxy);
    shaka.media.ManifestParser.registerParserByMime("application/vnd.apple.mpegurl", manifest_parser_proxy_1.ShakaHlsManifestParserProxy);
}
function initializeNetworkingEngine() {
    debug("init networking engine");
    shaka.net.NetworkingEngine.registerScheme("http", processNetworkRequest);
    shaka.net.NetworkingEngine.registerScheme("https", processNetworkRequest);
}
function processNetworkRequest(uri, request, requestType, progressUpdated) {
    if (!request.p2pml) {
        return shaka.net.HttpXHRPlugin(uri, request, requestType, progressUpdated);
    }
    const { player, segmentManager } = request.p2pml;
    let assetsStorage = segmentManager.getSettings().assetsStorage;
    let masterManifestUri;
    let masterSwarmId;
    if (assetsStorage !== undefined
        && player.getNetworkingEngine().p2pml !== undefined
        && player.getNetworkingEngine().p2pml.masterManifestUri !== undefined) {
        masterManifestUri = player.getNetworkingEngine().p2pml.masterManifestUri;
        masterSwarmId = utils_1.getMasterSwarmId(masterManifestUri, segmentManager.getSettings());
    }
    else {
        assetsStorage = undefined;
    }
    let segment;
    const manifest = player.getManifest();
    if (requestType === shaka.net.NetworkingEngine.RequestType.SEGMENT
        && manifest !== null
        && manifest.p2pml !== undefined
        && manifest.p2pml.parser !== undefined) {
        segment = manifest.p2pml.parser.find(uri, request.headers.Range);
    }
    if (segment !== undefined && segment.streamType === "video") { // load segment using P2P loader
        debug("request", "load", segment.identity);
        const promise = segmentManager.load(segment, utils_1.getSchemedUri(player.getAssetUri ? player.getAssetUri() : player.getManifestUri()), getPlayheadTime(player));
        const abort = async () => {
            debug("request", "abort", segment.identity);
            // TODO: implement abort in SegmentManager
        };
        return new shaka.util.AbortableOperation(promise, abort);
    }
    else if (assetsStorage) { // load or store the asset using assets storage
        const responsePromise = (async () => {
            const asset = await assetsStorage.getAsset(uri, request.headers.Range, masterSwarmId);
            if (asset !== undefined) {
                return {
                    data: asset.data,
                    uri: asset.responseUri,
                    fromCache: true
                };
            }
            else {
                const response = await shaka.net.HttpXHRPlugin(uri, request, requestType, progressUpdated).promise;
                assetsStorage.storeAsset({
                    masterManifestUri: masterManifestUri,
                    masterSwarmId: masterSwarmId,
                    requestUri: uri,
                    requestRange: request.headers.Range,
                    responseUri: response.uri,
                    data: response.data
                });
                return response;
            }
        })();
        return new shaka.util.AbortableOperation(responsePromise, async () => { });
    }
    else { // load asset using default plugin
        return shaka.net.HttpXHRPlugin(uri, request, requestType, progressUpdated);
    }
}
function getPlayheadTime(player) {
    let time = 0;
    const date = player.getPlayheadTimeAsDate();
    if (date) {
        time = date.valueOf();
        if (player.isLive()) {
            time -= player.getPresentationStartTimeAsDate().valueOf();
        }
        time /= 1000;
    }
    return time;
}

},{"./manifest-parser-proxy":4,"./utils":7,"debug":"debug"}],4:[function(require,module,exports){
"use strict";
/**
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const parser_segment_1 = require("./parser-segment");
class ShakaManifestParserProxy {
    constructor(originalManifestParser) {
        this.cache = new parser_segment_1.ParserSegmentCache(200);
        this.originalManifestParser = originalManifestParser;
    }
    isHls() { return this.originalManifestParser instanceof shaka.hls.HlsParser; }
    isDash() { return this.originalManifestParser instanceof shaka.dash.DashParser; }
    start(uri, playerInterface) {
        // Tell P2P Media Loader's networking engine code about currently loading manifest
        if (playerInterface.networkingEngine.p2pml === undefined) {
            playerInterface.networkingEngine.p2pml = {};
        }
        playerInterface.networkingEngine.p2pml.masterManifestUri = uri;
        return this.originalManifestParser.start(uri, playerInterface).then((manifest) => {
            this.manifest = manifest;
            for (const period of manifest.periods) {
                const processedStreams = [];
                for (const variant of period.variants) {
                    if ((variant.video != null) && (processedStreams.indexOf(variant.video) == -1)) {
                        this.hookGetSegmentReference(variant.video);
                        processedStreams.push(variant.video);
                    }
                    if ((variant.audio != null) && (processedStreams.indexOf(variant.audio) == -1)) {
                        this.hookGetSegmentReference(variant.audio);
                        processedStreams.push(variant.audio);
                    }
                }
            }
            manifest.p2pml = { parser: this };
            return manifest;
        });
    }
    configure(config) {
        return this.originalManifestParser.configure(config);
    }
    stop() {
        return this.originalManifestParser.stop();
    }
    update() {
        return this.originalManifestParser.update();
    }
    onExpirationUpdated() {
        return this.originalManifestParser.onExpirationUpdated();
    }
    find(uri, range) {
        return this.cache.find(uri, range);
    }
    reset() {
        this.cache.clear();
    }
    hookGetSegmentReference(stream) {
        stream.getSegmentReferenceOriginal = stream.getSegmentReference;
        stream.getSegmentReference = (segmentNumber) => {
            this.cache.add(stream, segmentNumber);
            return stream.getSegmentReferenceOriginal(segmentNumber);
        };
        stream.getPosition = () => {
            if (this.isHls()) {
                if (stream.type === "video") {
                    return this.manifest.periods[0].variants.reduce((a, i) => {
                        if (i.video && i.video.id && !a.includes(i.video.id)) {
                            a.push(i.video.id);
                        }
                        return a;
                    }, []).indexOf(stream.id);
                }
            }
            return -1;
        };
    }
} // end of ShakaManifestParserProxy
exports.ShakaManifestParserProxy = ShakaManifestParserProxy;
class ShakaDashManifestParserProxy extends ShakaManifestParserProxy {
    constructor() {
        super(new shaka.dash.DashParser());
    }
}
exports.ShakaDashManifestParserProxy = ShakaDashManifestParserProxy;
class ShakaHlsManifestParserProxy extends ShakaManifestParserProxy {
    constructor() {
        super(new shaka.hls.HlsParser());
    }
}
exports.ShakaHlsManifestParserProxy = ShakaHlsManifestParserProxy;

},{"./parser-segment":5}],5:[function(require,module,exports){
"use strict";
/**
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("./utils");
class ParserSegment {
    constructor(streamId, streamType, streamPosition, streamIdentity, identity, position, start, end, uri, range, prev, next) {
        this.streamId = streamId;
        this.streamType = streamType;
        this.streamPosition = streamPosition;
        this.streamIdentity = streamIdentity;
        this.identity = identity;
        this.position = position;
        this.start = start;
        this.end = end;
        this.uri = uri;
        this.range = range;
        this.prev = prev;
        this.next = next;
    }
    static create(stream, position) {
        const ref = stream.getSegmentReferenceOriginal(position);
        if (!ref) {
            return undefined;
        }
        const uris = ref.createUris();
        if (!uris || uris.length === 0) {
            return undefined;
        }
        const start = ref.getStartTime();
        const end = ref.getEndTime();
        const startByte = ref.getStartByte();
        const endByte = ref.getEndByte();
        const range = startByte || endByte
            ? `bytes=${startByte || ""}-${endByte || ""}`
            : undefined;
        const streamTypeCode = stream.type.substring(0, 1).toUpperCase();
        const streamPosition = stream.getPosition();
        const streamIsHls = streamPosition >= 0;
        const streamIdentity = streamIsHls
            ? `${streamTypeCode}${streamPosition}`
            : `${streamTypeCode}${stream.id}`;
        const identity = streamIsHls
            ? `${position}`
            : `${Number(start).toFixed(3)}`;
        return new ParserSegment(stream.id, stream.type, streamPosition, streamIdentity, identity, position, start, end, utils_1.getSchemedUri(uris[0]), range, () => ParserSegment.create(stream, position - 1), () => ParserSegment.create(stream, position + 1));
    }
} // end of ParserSegment
exports.ParserSegment = ParserSegment;
class ParserSegmentCache {
    constructor(maxSegments) {
        this.segments = [];
        this.maxSegments = maxSegments;
    }
    find(uri, range) {
        return this.segments.find(i => i.uri === uri && i.range === range);
    }
    add(stream, position) {
        const segment = ParserSegment.create(stream, position);
        if (segment && !this.find(segment.uri, segment.range)) {
            this.segments.push(segment);
            if (this.segments.length > this.maxSegments) {
                this.segments.splice(0, this.maxSegments * 0.2);
            }
        }
    }
    clear() {
        this.segments.splice(0);
    }
} // end of ParserSegmentCache
exports.ParserSegmentCache = ParserSegmentCache;

},{"./utils":7}],6:[function(require,module,exports){
"use strict";
/**
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const Debug = require("debug");
const p2p_media_loader_core_1 = require("p2p-media-loader-core");
const utils_1 = require("./utils");
const defaultSettings = {
    forwardSegmentCount: 20,
    maxHistorySegments: 50,
    swarmId: undefined,
    assetsStorage: undefined,
};
class SegmentManager {
    constructor(loader, settings = {}) {
        this.debug = Debug("p2pml:shaka:sm");
        this.requests = new Map();
        this.manifestUri = "";
        this.playheadTime = 0;
        this.segmentHistory = [];
        this.onSegmentLoaded = (segment) => {
            if (this.requests.has(segment.id)) {
                this.reportSuccess(this.requests.get(segment.id), segment);
                this.debug("request delete", segment.id);
                this.requests.delete(segment.id);
            }
        };
        this.onSegmentError = (segment, error) => {
            if (this.requests.has(segment.id)) {
                this.reportError(this.requests.get(segment.id), error);
                this.debug("request delete from error", segment.id);
                this.requests.delete(segment.id);
            }
        };
        this.onSegmentAbort = (segment) => {
            if (this.requests.has(segment.id)) {
                this.reportError(this.requests.get(segment.id), "Internal abort");
                this.debug("request delete from abort", segment.id);
                this.requests.delete(segment.id);
            }
        };
        this.settings = Object.assign(Object.assign({}, defaultSettings), settings);
        this.loader = loader;
        this.loader.on(p2p_media_loader_core_1.Events.SegmentLoaded, this.onSegmentLoaded);
        this.loader.on(p2p_media_loader_core_1.Events.SegmentError, this.onSegmentError);
        this.loader.on(p2p_media_loader_core_1.Events.SegmentAbort, this.onSegmentAbort);
    }
    async destroy() {
        if (this.requests.size !== 0) {
            console.error("Destroying segment manager with active request(s)!");
            for (const request of this.requests.values()) {
                this.reportError(request, "Request aborted due to destroy call");
            }
            this.requests.clear();
        }
        this.playheadTime = 0;
        this.segmentHistory.splice(0);
        if (this.settings.assetsStorage !== undefined) {
            await this.settings.assetsStorage.destroy();
        }
        await this.loader.destroy();
    }
    getSettings() {
        return this.settings;
    }
    async load(parserSegment, manifestUri, playheadTime) {
        this.manifestUri = manifestUri;
        this.playheadTime = playheadTime;
        this.pushSegmentHistory(parserSegment);
        const lastRequestedSegment = this.refreshLoad();
        const alreadyLoadedSegment = await this.loader.getSegment(lastRequestedSegment.id);
        return new Promise((resolve, reject) => {
            const request = new Request(lastRequestedSegment.id, resolve, reject);
            if (alreadyLoadedSegment) {
                this.reportSuccess(request, alreadyLoadedSegment);
            }
            else {
                this.debug("request add", request.id);
                this.requests.set(request.id, request);
            }
        });
    }
    setPlayheadTime(time) {
        this.playheadTime = time;
        if (this.segmentHistory.length > 0) {
            this.refreshLoad();
        }
    }
    refreshLoad() {
        const lastRequestedSegment = this.segmentHistory[this.segmentHistory.length - 1];
        const safePlayheadTime = this.playheadTime > 0.1 ? this.playheadTime : lastRequestedSegment.start;
        const sequence = this.segmentHistory.reduce((a, i) => {
            if (i.start >= safePlayheadTime) {
                a.push(i);
            }
            return a;
        }, []);
        if (sequence.length === 0) {
            sequence.push(lastRequestedSegment);
        }
        const lastRequestedSegmentIndex = sequence.length - 1;
        do {
            const next = sequence[sequence.length - 1].next();
            if (next) {
                sequence.push(next);
            }
            else {
                break;
            }
        } while (sequence.length < this.settings.forwardSegmentCount);
        const masterSwarmId = utils_1.getMasterSwarmId(this.manifestUri, this.settings);
        const loaderSegments = sequence.map((s, i) => ({
            id: `${masterSwarmId}+${s.streamIdentity}+${s.identity}`,
            url: s.uri,
            masterSwarmId: masterSwarmId,
            masterManifestUri: this.manifestUri,
            streamId: s.streamIdentity,
            sequence: s.identity,
            range: s.range,
            priority: i,
        }));
        this.loader.load(loaderSegments, `${masterSwarmId}+${lastRequestedSegment.streamIdentity}`);
        return loaderSegments[lastRequestedSegmentIndex];
    }
    pushSegmentHistory(segment) {
        if (this.segmentHistory.length >= this.settings.maxHistorySegments) {
            this.debug("segment history auto shrink");
            this.segmentHistory.splice(0, this.settings.maxHistorySegments * 0.2);
        }
        if (this.segmentHistory.length > 0 && this.segmentHistory[this.segmentHistory.length - 1].start > segment.start) {
            this.debug("segment history reset due to playhead seek back");
            this.segmentHistory.splice(0);
        }
        this.segmentHistory.push(segment);
    }
    reportSuccess(request, loaderSegment) {
        let timeMs;
        if (loaderSegment.downloadBandwidth !== undefined && loaderSegment.downloadBandwidth > 0 && loaderSegment.data && loaderSegment.data.byteLength > 0) {
            timeMs = Math.trunc(loaderSegment.data.byteLength / loaderSegment.downloadBandwidth);
        }
        this.debug("report success", request.id);
        request.resolve({ data: loaderSegment.data, timeMs });
    }
    reportError(request, error) {
        if (request.reject) {
            this.debug("report error", request.id);
            request.reject(error);
        }
    }
} // end of SegmentManager
exports.SegmentManager = SegmentManager;
class Request {
    constructor(id, resolve, reject) {
        this.id = id;
        this.resolve = resolve;
        this.reject = reject;
    }
}

},{"./utils":7,"debug":"debug","p2p-media-loader-core":"p2p-media-loader-core"}],7:[function(require,module,exports){
"use strict";
/**
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
function getSchemedUri(uri) {
    return uri.startsWith("//") ? window.location.protocol + uri : uri;
}
exports.getSchemedUri = getSchemedUri;
function getMasterSwarmId(masterManifestUri, settings) {
    return (settings.swarmId && (settings.swarmId.length !== 0)) ?
        settings.swarmId : masterManifestUri.split("?")[0];
}
exports.getMasterSwarmId = getMasterSwarmId;

},{}],"p2p-media-loader-shaka":[function(require,module,exports){
"use strict";
/**
 * @license Apache-2.0
 * Copyright 2018 Novage LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
function __export(m) {
    for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
}
Object.defineProperty(exports, "__esModule", { value: true });
exports.version = "0.6.2";
__export(require("./engine"));
__export(require("./segment-manager"));

},{"./engine":2,"./segment-manager":6}]},{},[1]);
