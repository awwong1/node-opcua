/**
 * @module node-opcua-transport
 */
import os from "os";
import { createConnection } from "net";
import { types } from "util";
import chalk from "chalk";

import { assert } from "node-opcua-assert";
import { BinaryStream } from "node-opcua-binary-stream";
import { readMessageHeader } from "node-opcua-chunkmanager";
import { ErrorCallback } from "node-opcua-status-code";
import { checkDebugFlag, make_debugLog, make_errorLog, make_warningLog } from "node-opcua-debug";
import { getFakeTransport, ISocketLike, TCP_transport } from "./tcp_transport";
import { decodeMessage, packTcpMessage, parseEndpointUrl } from "./tools";

import { AcknowledgeMessage } from "./AcknowledgeMessage";
import { HelloMessage } from "./HelloMessage";
import { TCPErrorMessage } from "./TCPErrorMessage";
import { doTraceHelloAck } from "./utils";

const doDebug = checkDebugFlag(__filename);
const debugLog = make_debugLog(__filename);
const warningLog = make_warningLog(__filename);
const errorLog = make_errorLog(__filename);
const gHostname = os.hostname();

function createClientSocket(endpointUrl: string, timeout: number): ISocketLike {
    // create a socket based on Url
    const ep = parseEndpointUrl(endpointUrl);
    const port = parseInt(ep.port!, 10);
    const hostname = ep.hostname!;

    let socket: ISocketLike;
    switch (ep.protocol) {
        case "opc.tcp:":
            socket = createConnection({ host: hostname, port, timeout }, () => {
                doDebug && debugLog(`connected to server! ${hostname}:${port} timeout:${timeout} `);
            });
            
            socket.setNoDelay(false);
            socket.setKeepAlive(true, timeout >> 1);


            return socket;
        case "fake:":
            assert(ep.protocol === "fake:", " Unsupported transport protocol");
            socket = getFakeTransport();
            return socket;

        case "websocket:":
        case "http:":
        case "https:":
        default: {
            const msg = "[NODE-OPCUA-E05] this transport protocol is not supported :" + ep.protocol;
            errorLog(msg);
            throw new Error(msg);
        }
    }
}
export interface ClientTCP_transport {
    on(eventName: "chunk", eventHandler: (messageChunk: Buffer) => void): this;
    on(eventName: "close", eventHandler: (err: Error | null) => void): this;
    on(eventName: "connection_break", eventHandler: () => void): this;
    on(eventName: "connect", eventHandler: () => void): this;

    once(eventName: "chunk", eventHandler: (messageChunk: Buffer) => void): this;
    once(eventName: "close", eventHandler: (err: Error | null) => void): this;
    once(eventName: "connection_break", eventHandler: () => void): this;
    once(eventName: "connect", eventHandler: () => void): this;

    emit(eventName: "chunk", messageChunk: Buffer): boolean;
    emit(eventName: "close", err?: Error | null): boolean;
    emit(eventName: "connection_break"): boolean;
    emit(eventName: "connect"): boolean;
}

export interface TransportSettingsOptions {
    maxChunkCount?: number;
    maxMessageSize?: number;
    receiveBufferSize?: number;
    sendBufferSize?: number;
}

/**
 * a ClientTCP_transport connects to a remote server socket and
 * initiates a communication with a HEL/ACK transaction.
 * It negotiates the communication parameters with the other end.

 * @example
 *
 *    ```javascript
 *    const transport = ClientTCP_transport(url);
 *
 *    transport.timeout = 10000;
 *
 *    transport.connect(function (err)) {
 *         if (err) {
 *            // cannot connect
 *         } else {
 *            // connected
 *
 *         }
 *    });
 *    ....
 *
 *    transport.write(message_chunk, 'F');
 *
 *    ....
 *
 *    transport.on("chunk", function (message_chunk) {
 *        // do something with chunk from server...
 *    });
 *
 *
 * ```
 *
 *
 */
export class ClientTCP_transport extends TCP_transport {
    public static defaultMaxChunk = 0; // 0 - no limits
    public static defaultMaxMessageSize = 0; // 0 - no limits
    public static defaultReceiveBufferSize = 1024 * 64 * 10;
    public static defaultSendBufferSize = 1024 * 64 * 10; // 8192 min,

    public endpointUrl: string;
    public serverUri: string;
    public numberOfRetry: number;
    public parameters?: AcknowledgeMessage;

    private _counter: number;
    private _helloSettings: {
        maxChunkCount: number;
        maxMessageSize: number;
        receiveBufferSize: number;
        sendBufferSize: number;
    };
    constructor(transportSettings?: TransportSettingsOptions) {
        super();
        this.endpointUrl = "";
        this.serverUri = "";
        this._counter = 0;
        this.numberOfRetry = 0;

        // initially before HEL/ACK
        this.maxChunkCount = 1;
        this.maxMessageSize = 4 * 1024;
        this.receiveBufferSize = 4 * 1024;

        transportSettings = transportSettings || {};
        this._helloSettings = {
            maxChunkCount: transportSettings.maxChunkCount || ClientTCP_transport.defaultMaxChunk,
            maxMessageSize: transportSettings.maxMessageSize || ClientTCP_transport.defaultMaxMessageSize,
            receiveBufferSize: transportSettings.receiveBufferSize || ClientTCP_transport.defaultReceiveBufferSize,
            sendBufferSize: transportSettings.sendBufferSize || ClientTCP_transport.defaultSendBufferSize
        };
    }

    public getTransportSettings(): TransportSettingsOptions {
        return this._helloSettings;
    }

    public dispose(): void {
        /* istanbul ignore next */
        doDebug && debugLog(" ClientTCP_transport disposed");

        super.dispose();
    }

    public connect(endpointUrl: string, callback: ErrorCallback): void {

        const ep = parseEndpointUrl(endpointUrl);
        this.endpointUrl = endpointUrl;
        this.serverUri = "urn:" + gHostname + ":Sample";
        /* istanbul ignore next */
        doDebug && debugLog(chalk.cyan("ClientTCP_transport#connect(endpointUrl = " + endpointUrl + ")"));
        let socket: ISocketLike | null = null;
        try {
            socket = createClientSocket(endpointUrl, this.timeout);
          
            socket.setTimeout(this.timeout >> 1, () => {
                this.forceConnectionBreak();
            });
            
        } catch (err) {
            /* istanbul ignore next */
            doDebug && debugLog("CreateClientSocket has failed");

            return callback(err as Error);
        }

        /**
         *
         */
        const _on_socket_error_after_connection = (err: Error) => {
            /* istanbul ignore next */
            doDebug && debugLog(" _on_socket_error_after_connection ClientTCP_transport Socket Error", err.message);

            // EPIPE : EPIPE (Broken pipe): A write on a pipe, socket, or FIFO for which there is no process to read the
            // data. Commonly encountered at the net and http layers, indicative that the remote side of the stream
            // being written to has been closed.

            // ECONNRESET (Connection reset by peer): A connection was forcibly closed by a peer. This normally results
            // from a loss of the connection on the remote socket due to a timeout or reboot. Commonly encountered
            // via the http and net module

            //  socket termination could happen:
            //   * when the socket times out (lost of connection, network outage, etc...)
            //   * or, when the server abruptly disconnects the socket ( in case of invalid communication for instance)
            if (err.message.match(/ECONNRESET|EPIPE|premature socket termination/)) {
                /**
                 * @event connection_break
                 *
                 */
                warningLog("connection_break", endpointUrl);
                this.emit("connection_break");
            }
        };

        const _on_socket_connect = () => {
            /* istanbul ignore next */
            doDebug && debugLog("entering _on_socket_connect");

            _remove_connect_listeners();
            this._perform_HEL_ACK_transaction((err) => {
                if (!err) {
                    /* istanbul ignore next */
                    if (!this._socket) {
                        return callback(new Error("Abandoned"));                        
                    }
                    // install error handler to detect connection break
                    this._socket.on("error", _on_socket_error_after_connection);
                    /**
                     * notify the observers that the transport is connected (the socket is connected and the the HEL/ACK
                     * transaction has been done)
                     * @event connect
                     *
                     */
                    this.emit("connect");
                } else {
                    debugLog("_perform_HEL_ACK_transaction has failed with err=", err.message);
                }
                callback(err);
            });
        };

        const _on_socket_error_for_connect = (err: Error) => {
            // this handler will catch attempt to connect to an inaccessible address.
            /* istanbul ignore next */
            doDebug && debugLog(chalk.cyan("ClientTCP_transport#connect - _on_socket_error_for_connect"), err.message);
            assert(types.isNativeError(err));
            _remove_connect_listeners();
            callback(err);
        };

        const _on_socket_end_for_connect = () => {
            /* istanbul ignore next */
            doDebug &&
                debugLog(chalk.cyan("ClientTCP_transport#connect -> _on_socket_end_for_connect Socket has been closed by server"));
        };

        const _remove_connect_listeners = () => {
            /* istanbul ignore next */
            if (!this._socket) {
                return;
            }
            this._socket.removeListener("error", _on_socket_error_for_connect);
            this._socket.removeListener("end", _on_socket_end_for_connect);
        };

        this._install_socket(socket);

        this._socket!.once("error", _on_socket_error_for_connect);
        this._socket!.once("end", _on_socket_end_for_connect);
        this._socket!.once("connect", _on_socket_connect);
    }

    private _handle_ACK_response(messageChunk: Buffer, callback: ErrorCallback) {
        const _stream = new BinaryStream(messageChunk);
        const messageHeader = readMessageHeader(_stream);
        let err;
        /* istanbul ignore next */
        if (messageHeader.isFinal !== "F") {
            err = new Error(" invalid ACK message");
            return callback(err);
        }

        let responseClass;
        let response;

        if (messageHeader.msgType === "ERR") {
            responseClass = TCPErrorMessage;
            _stream.rewind();
            response = decodeMessage(_stream, responseClass) as TCPErrorMessage;

            err = new Error("ACK: ERR received " + response.statusCode.toString() + " : " + response.reason);
            (err as any).statusCode = response.statusCode;
            // istanbul ignore next
            doTraceHelloAck && warningLog("receiving ERR instead of Ack", response.toString());

            callback(err);
        } else {
            responseClass = AcknowledgeMessage;
            _stream.rewind();
            response = decodeMessage(_stream, responseClass);

            this.parameters = response as AcknowledgeMessage;
            this.setLimits(response as AcknowledgeMessage);

            // istanbul ignore next
            doTraceHelloAck && warningLog("receiving Ack\n", response.toString());

            callback();
        }
    }

    private _send_HELLO_request() {
        /* istanbul ignore next */
        doDebug && debugLog("entering _send_HELLO_request");

        assert(this._socket);
        assert(isFinite(this.protocolVersion));
        assert(this.endpointUrl.length > 0, " expecting a valid endpoint url");

        const { maxChunkCount, maxMessageSize, receiveBufferSize, sendBufferSize } = this._helloSettings;

        // Write a message to the socket as soon as the client is connected,
        // the server will receive it as message from the client
        const helloMessage = new HelloMessage({
            endpointUrl: this.endpointUrl,
            protocolVersion: this.protocolVersion,
            maxChunkCount,
            maxMessageSize,
            receiveBufferSize,
            sendBufferSize
        });
        // istanbul ignore next
        doTraceHelloAck && warningLog(`sending Hello\n ${helloMessage.toString()} `);

        const messageChunk = packTcpMessage("HEL", helloMessage);
        this._write_chunk(messageChunk);
    }

    private _on_ACK_response(externalCallback: ErrorCallback, err: Error | null, data?: Buffer) {
        /* istanbul ignore next */
        doDebug && debugLog("entering _on_ACK_response");

        assert(typeof externalCallback === "function");
        assert(this._counter === 0, "Ack response should only be received once !");
        this._counter += 1;

        if (err || !data) {
            externalCallback(err || new Error("no data"));
            if (this._socket) {
                this._socket.end();
            }
        } else {
            this._handle_ACK_response(data, externalCallback);
        }
    }

    private _perform_HEL_ACK_transaction(callback: ErrorCallback) {
        /* istanbul ignore next */
        if (!this._socket) {
            return callback(new Error("No socket available to perform HEL/ACK transaction"));
        }
        assert(this._socket, "expecting a valid socket to send a message");
        assert(typeof callback === "function");
        this._counter = 0;
        /* istanbul ignore next */
        doDebug && debugLog("entering _perform_HEL_ACK_transaction");

        this._install_one_time_message_receiver((err: Error | null, data?: Buffer) => {
            /* istanbul ignore next */
            doDebug && debugLog("before  _on_ACK_response ", err ? err.message : "");

            this._on_ACK_response(callback, err, data);
        });
        this._send_HELLO_request();
    }
}
