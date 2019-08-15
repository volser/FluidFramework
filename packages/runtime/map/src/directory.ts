/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    FileMode,
    ISequencedDocumentMessage,
    ITree,
    MessageType,
    TreeEntry,
} from "@prague/protocol-definitions";
import { IComponentRuntime, IObjectStorageService, ISharedObjectServices } from "@prague/runtime-definitions";
import { ISharedObjectFactory, SharedObject, ValueType } from "@prague/shared-object-common";
import { posix } from "path";
import { debug } from "./debug";
import {
    IDirectory,
    IDirectoryValueChanged,
    ISerializableValue,
    ISharedDirectory,
    IValueChanged,
    IValueOpEmitter,
    IValueType,
    IValueTypeOperationValue,
} from "./interfaces";
import { ILocalValue, LocalValueMaker, ValueTypeLocalValue } from "./localValues";

const snapshotFileName = "header";

interface IDirectoryMessageHandler {
    prepare(
        op: IDirectoryOperation,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): Promise<ILocalValue | void>;
    process(
        op: IDirectoryOperation,
        context: ILocalValue,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): void;
    submit(op: IDirectoryOperation): void;
}

interface IDirectoryValueTypeOperation {
    type: "act";
    key: string;
    path: string;
    value: IValueTypeOperationValue;
}

interface IDirectorySetOperation {
    type: "set";
    key: string;
    path: string;
    value: ISerializableValue;
}

interface IDirectoryDeleteOperation {
    type: "delete";
    key: string;
    path: string;
}

/**
 * An operation on a specific key within a directory
 */
type IDirectoryKeyOperation = IDirectoryValueTypeOperation | IDirectorySetOperation | IDirectoryDeleteOperation;

interface IDirectoryClearOperation {
    type: "clear";
    path: string;
}

/**
 * An operation on one or more of the keys within a directory
 */
type IDirectoryStorageOperation = IDirectoryKeyOperation | IDirectoryClearOperation;

interface IDirectoryCreateSubDirectoryOperation {
    type: "createSubDirectory";
    path: string;
    subdirName: string;
}

interface IDirectoryDeleteSubDirectoryOperation {
    type: "deleteSubDirectory";
    path: string;
    subdirName: string;
}

/**
 * An operation on the subdirectories within a directory
 */
type IDirectorySubDirectoryOperation = IDirectoryCreateSubDirectoryOperation | IDirectoryDeleteSubDirectoryOperation;

/**
 * Any operation on a directory
 */
type IDirectoryOperation = IDirectoryStorageOperation | IDirectorySubDirectoryOperation;

// Defines the in-memory object structure to be used for the conversion to/from serialized.
// Directly used in JSON.stringify, direct result from JSON.parse
/**
 * @internal
 */
export interface IDirectoryDataObject {
    storage?: {[key: string]: ISerializableValue};
    subdirectories?: {[subdirName: string]: IDirectoryDataObject};
}

/**
 * The factory that defines the directory
 */
export class DirectoryFactory {
    public static readonly Type = "https://graph.microsoft.com/types/directory";

    public readonly type: string = DirectoryFactory.Type;
    public readonly snapshotFormatVersion: string = "0.1";

    constructor(private readonly defaultValueTypes: Array<IValueType<any>> = []) {
    }

    public async load(
        runtime: IComponentRuntime,
        id: string,
        minimumSequenceNumber: number,
        services: ISharedObjectServices,
        headerOrigin: string): Promise<ISharedDirectory> {

        const directory = new SharedDirectory(id, runtime);
        this.registerValueTypes(directory);
        await directory.load(minimumSequenceNumber, headerOrigin, services);

        return directory;
    }

    public create(document: IComponentRuntime, id: string): ISharedDirectory {
        const directory = new SharedDirectory(id, document);
        this.registerValueTypes(directory);
        directory.initializeLocal();

        return directory;
    }

    private registerValueTypes(directory: SharedDirectory): void {
        for (const type of this.defaultValueTypes) {
            directory.registerValueType(type);
        }
    }
}

/**
 * SharedDirectory provides a hierarchical organization of map-like data structures as SubDirectories.
 * The values stored within can be accessed like a map, and the hierarchy can be navigated using path syntax.
 * SubDirectories can be retrieved for use as working directories.  E.g.:
 * mySharedDirectory.createSubDirectory("a").createSubDirectory("b").createSubDirectory("c").set("foo", val1);
 * const mySubDir = mySharedDirectory.getWorkingDirectory("/a/b/c");
 * mySubDir.get("foo"); // val1
 */
export class SharedDirectory extends SharedObject implements ISharedDirectory {
    /**
     * Create a new shared directory
     *
     * @param runtime - component runtime the new shared directory belongs to
     * @param id - optional name of the shared directory
     * @returns newly create shared directory (but not attached yet)
     */
    public static create(runtime: IComponentRuntime, id?: string): SharedDirectory {
        return runtime.createChannel(SharedObject.getIdForCreate(id), DirectoryFactory.Type) as SharedDirectory;
    }

    /**
     * Get a factory for SharedDirectory to register with the component.
     *
     * @returns a factory that creates and load SharedDirectory
     */
    public static getFactory(defaultValueTypes: Array<IValueType<any>> = []): ISharedObjectFactory {
        return new DirectoryFactory(defaultValueTypes);
    }

    public [Symbol.toStringTag]: string = "SharedDirectory";
    /**
     * @internal
     */
    public readonly localValueMaker: LocalValueMaker;

    private readonly root: SubDirectory = new SubDirectory(this, this.runtime, posix.sep);
    private readonly messageHandlers: Map<string, IDirectoryMessageHandler> = new Map();

    /**
     * Constructs a new shared directory. If the object is non-local an id and service interfaces will
     * be provided.
     * @param id - string identifier for the SharedDirectory
     * @param runtime - component runtime
     * @param type - type identifier
     */
    constructor(
        id: string,
        runtime: IComponentRuntime,
    ) {
        super(id, runtime, DirectoryFactory.Type);
        this.localValueMaker = new LocalValueMaker(runtime, this);
        this.setMessageHandlers();
    }

    public get<T = any>(key: string): T {
        return this.root.get<T>(key);
    }

    public async wait<T = any>(key: string): Promise<T> {
        return this.root.wait<T>(key);
    }

    public set<T = any>(key: string, value: T, type?: string): this {
        this.root.set(key, value, type);
        return this;
    }

    public delete(key: string): boolean {
        return this.root.delete(key);
    }

    public clear(): void {
        this.root.clear();
    }

    public has(key: string): boolean {
        return this.root.has(key);
    }

    public get size(): number {
        return this.root.size;
    }

    public forEach(callback: (value: any, key: string, map: Map<string, any>) => void): void {
        this.root.forEach(callback);
    }

    public [Symbol.iterator](): IterableIterator<[string, any]> {
        return this.root[Symbol.iterator]();
    }

    public entries(): IterableIterator<[string, any]> {
        return this.root.entries();
    }

    public keys(): IterableIterator<string> {
        return this.root.keys();
    }

    public values(): IterableIterator<any> {
        return this.root.values();
    }

    public createSubDirectory(subdirName: string): SubDirectory {
        return this.root.createSubDirectory(subdirName);
    }

    public getSubDirectory(subdirName: string): SubDirectory {
        return this.root.getSubDirectory(subdirName);
    }

    public hasSubDirectory(subdirName: string): boolean {
        return this.root.hasSubDirectory(subdirName);
    }

    public deleteSubDirectory(subdirName: string): boolean {
        return this.root.deleteSubDirectory(subdirName);
    }

    /**
     * Get a SubDirectory within the directory, in order to use relative paths from that location.
     * @param path - path of the SubDirectory to get, relative to the root
     */
    public getWorkingDirectory(path: string): SubDirectory {
        const absolutePath = this.makeAbsolute(path);
        if (absolutePath === posix.sep) {
            return this.root;
        }

        let currentSubDir = this.root;
        const subdirs = absolutePath.substr(1).split(posix.sep);
        for (const subdir of subdirs) {
            currentSubDir = currentSubDir.getSubDirectory(subdir);
            if (!currentSubDir) {
                return undefined;
            }
        }
        return currentSubDir;
    }

    public snapshot(): ITree {
        const tree: ITree = {
            entries: [
                {
                    mode: FileMode.File,
                    path: snapshotFileName,
                    type: TreeEntry[TreeEntry.Blob],
                    value: {
                        contents: this.serialize(),
                        encoding: "utf-8",
                    },
                },
            ],
            id: null,
        };
        return tree;
    }

    /**
     * Registers a new value type on the directory
     */
    public registerValueType<T>(type: IValueType<T>) {
        this.localValueMaker.registerValueType(type);
    }

    /**
     * Registers a listener on the specified events
     */
    public on(
        event: "pre-op" | "op",
        listener: (op: ISequencedDocumentMessage, local: boolean, target: this) => void): this;
    public on(event: "valueChanged", listener: (
        changed: IDirectoryValueChanged,
        local: boolean,
        op: ISequencedDocumentMessage,
        target: this) => void): this;
    public on(event: string | symbol, listener: (...args: any[]) => void): this;

    /* tslint:disable:no-unnecessary-override */
    public on(event: string | symbol, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    /**
     * Returns the contents of the SharedDirectory as a string which can be rehydrate into a SharedDirectory
     * when loaded using populate().
     * @internal
     */
    public serialize(): string {
        const serializableDirectoryData: IDirectoryDataObject = {};

        // Map SubDirectories that need serializing to the corresponding data objects they will occupy
        const subdirsToSerialize = new Map<SubDirectory, IDirectoryDataObject>();
        subdirsToSerialize.set(this.root, serializableDirectoryData);

        for (const [currentSubDir, currentSubDirObject] of subdirsToSerialize) {
            const subDirStorage = currentSubDir.getSerializableStorage();
            if (subDirStorage) {
                currentSubDirObject.storage = subDirStorage;
            }

            for (const [subdirName, subdir] of currentSubDir.subdirectories()) {
                if (!currentSubDirObject.subdirectories) {
                    currentSubDirObject.subdirectories = {};
                }
                currentSubDirObject.subdirectories[subdirName] = {};
                subdirsToSerialize.set(subdir, currentSubDirObject.subdirectories[subdirName]);
            }
        }

        return JSON.stringify(serializableDirectoryData);
    }

    /**
     * @internal
     */
    public async populate(data: IDirectoryDataObject): Promise<void> {
        const localValuesP = new Array<Promise<void>>();

        // Map the data objects representing each subdirectory to their actual SubDirectory object
        const subdirsToDeserialize = new Map<IDirectoryDataObject, SubDirectory>();
        subdirsToDeserialize.set(data, this.root);

        for (const [currentSubDirObject, currentSubDir] of subdirsToDeserialize) {
            if (currentSubDirObject.subdirectories) {
                for (const [subdirName, subdirObject] of Object.entries(currentSubDirObject.subdirectories)) {
                    const newSubDir = currentSubDir.createSubDirectory(subdirName);
                    subdirsToDeserialize.set(subdirObject, newSubDir);
                }
            }

            if (currentSubDirObject.storage) {
                for (const [key, serializable] of Object.entries(currentSubDirObject.storage)) {
                    const populateP = this.makeLocal(
                                          key,
                                          currentSubDir.absolutePath,
                                          serializable,
                                      )
                                      .then((localValue) => currentSubDir.populateStorage(key, localValue));
                    localValuesP.push(populateP);
                }
            }
        }

        await Promise.all(localValuesP);
    }

    /**
     * Submits an operation
     * @param op - op to submit
     * @internal
     */
    public submitDirectoryMessage(op: IDirectoryOperation): number {
        return this.submitLocalMessage(op);
    }

    /**
     * @internal
     */
    public makeDirectoryValueOpEmitter(
        key: string,
        path: string,
    ): IValueOpEmitter {
        const emit = (opName: string, previousValue: any, params: any) => {
            const op: IDirectoryValueTypeOperation = {
                key,
                path,
                type: "act",
                value: {
                    opName,
                    value: params,
                },
            };

            this.submitDirectoryMessage(op);
            const event: IDirectoryValueChanged = { key, path, previousValue };
            this.emit("valueChanged", event, true, null);
        };
        return { emit };
    }

    protected onDisconnect() {
        debug(`Directory ${this.id} is now disconnected`);
    }

    protected onConnect(pending: any[]) {
        debug(`Directory ${this.id} is now connected`);

        // Deal with the directory messages - for the directory it's always last one wins so we just resend
        for (const message of pending as IDirectoryOperation[]) {
            const handler = this.messageHandlers.get(message.type);
            handler.submit(message);
        }
    }

    protected async loadCore(
        minimumSequenceNumber: number,
        headerOrigin: string,
        storage: IObjectStorageService) {

        const header = await storage.read(snapshotFileName);

        const data = header ? JSON.parse(Buffer.from(header, "base64")
            .toString("utf-8")) : {};
        await this.populate(data as IDirectoryDataObject);
    }

    /**
     * Registers all the shared objects stored in this directory.
     */
    protected registerCore(): void {
        const subdirsToRegisterFrom = new Array<SubDirectory>();
        subdirsToRegisterFrom.push(this.root);

        for (const currentSubDir of subdirsToRegisterFrom) {
            for (const value of currentSubDir.values()) {
                if (SharedObject.is(value)) {
                    value.register();
                }
            }

            for (const [, subdir] of currentSubDir.subdirectories()) {
                subdirsToRegisterFrom.push(subdir);
            }
        }
    }

    protected prepareCore(message: ISequencedDocumentMessage, local: boolean): Promise<any> {
        if (message.type === MessageType.Operation) {
            const op: IDirectoryOperation = message.contents as IDirectoryOperation;
            if (this.messageHandlers.has(op.type)) {
                return this.messageHandlers.get(op.type)
                    .prepare(op, local, message);
            }
        }

        return Promise.reject();
    }

    protected processCore(message: ISequencedDocumentMessage, local: boolean, context: any): void {
        if (message.type === MessageType.Operation) {
            const op: IDirectoryOperation = message.contents as IDirectoryOperation;
            if (this.messageHandlers.has(op.type)) {
                this.messageHandlers.get(op.type)
                    .process(op, context as ILocalValue, local, message);
            }
        }
    }

    /**
     * Converts the given relative path to absolute against the root.
     * @param path - the path to convert
     */
    private makeAbsolute(path: string): string {
        return posix.resolve(posix.sep, path);
    }

    /**
     * The remote ISerializableValue we're receiving (either as a result of a snapshot load or an incoming set op)
     * will have the information we need to create a real object, but will not be the real object yet.  For example,
     * we might know it's a map and the ID but not have the actual map or its data yet.  makeLocal's job
     * is to convert that information into a real object for local usage.
     * @param key - key of element being converted
     * @param path - path of element being converted
     * @param serializable - the remote information that we can convert into a real object
     */
    private async makeLocal(
        key: string,
        path: string,
        serializable: ISerializableValue,
    ): Promise<ILocalValue> {
        if (serializable.type === ValueType[ValueType.Plain] || serializable.type === ValueType[ValueType.Shared]) {
            return this.localValueMaker.fromSerializable(serializable);
        } else {
            return this.localValueMaker.fromSerializable(
                serializable,
                this.makeDirectoryValueOpEmitter(key, path),
            );
        }
    }

    // tslint:disable-next-line:max-func-body-length
    private setMessageHandlers() {
        const defaultPrepare = (op: IDirectoryOperation, local: boolean) => Promise.resolve();
        this.messageHandlers.set(
            "clear",
            {
                prepare: defaultPrepare,
                process: (op: IDirectoryClearOperation, context, local, message) => {
                    const subdir = this.getWorkingDirectory(op.path);
                    if (subdir) {
                        subdir.processClearMessage(op, context, local, message);
                    }
                },
                submit: (op: IDirectoryClearOperation) => {
                    const subdir = this.getWorkingDirectory(op.path);
                    if (subdir) {
                        subdir.submitClearMessage(op);
                    }
                },
            },
        );
        this.messageHandlers.set(
            "delete",
            {
                prepare: defaultPrepare,
                process: (op: IDirectoryDeleteOperation, context, local, message) => {
                    const subdir = this.getWorkingDirectory(op.path);
                    if (subdir) {
                        subdir.processDeleteMessage(op, context, local, message);
                    }
                },
                submit: (op: IDirectoryDeleteOperation) => {
                    const subdir = this.getWorkingDirectory(op.path);
                    if (subdir) {
                        subdir.submitKeyMessage(op);
                    }
                },
            },
        );
        this.messageHandlers.set(
            "set",
            {
                prepare: (op: IDirectorySetOperation, local) => {
                    return local ? Promise.resolve(null) : this.makeLocal(op.key, op.path, op.value);
                },
                process: (op: IDirectorySetOperation, context, local, message) => {
                    const subdir = this.getWorkingDirectory(op.path);
                    if (subdir) {
                        subdir.processSetMessage(op, context, local, message);
                    }
                },
                submit: (op: IDirectorySetOperation) => {
                    const subdir = this.getWorkingDirectory(op.path);
                    if (subdir) {
                        subdir.submitKeyMessage(op);
                    }
                },
            },
        );

        this.messageHandlers.set(
            "createSubDirectory",
            {
                prepare: defaultPrepare,
                process: (op: IDirectoryCreateSubDirectoryOperation, context, local, message) => {
                    const parentSubdir = this.getWorkingDirectory(op.path);
                    if (parentSubdir) {
                        parentSubdir.processCreateSubDirectoryMessage(op, context, local, message);
                    }
                },
                submit: (op: IDirectoryCreateSubDirectoryOperation) => {
                    const parentSubdir = this.getWorkingDirectory(op.path);
                    if (parentSubdir) {
                        parentSubdir.submitSubDirectoryMessage(op);
                    }
                },
            },
        );

        this.messageHandlers.set(
            "deleteSubDirectory",
            {
                prepare: defaultPrepare,
                process: (op: IDirectoryDeleteSubDirectoryOperation, context, local, message) => {
                    const parentSubdir = this.getWorkingDirectory(op.path);
                    if (parentSubdir) {
                        parentSubdir.processDeleteSubDirectoryMessage(op, context, local, message);
                    }
                },
                submit: (op: IDirectoryDeleteSubDirectoryOperation) => {
                    const parentSubdir = this.getWorkingDirectory(op.path);
                    if (parentSubdir) {
                        parentSubdir.submitSubDirectoryMessage(op);
                    }
                },
            },
        );

        // Ops with type "act" describe actions taken by custom value type handlers of whatever item is
        // being addressed.  These custom handlers can be retrieved from the ValueTypeLocalValue which has
        // stashed its valueType (and therefore its handlers).  We also emit a valueChanged for anyone
        // watching for manipulations of that item.
        this.messageHandlers.set(
            "act",
            {
                prepare: async (op: IDirectoryValueTypeOperation, local, message) => {
                    const subdir = this.getWorkingDirectory(op.path);
                    const localValue = subdir ? subdir.getLocalValue<ValueTypeLocalValue>(op.key) : undefined;
                    const handler = localValue.getOpHandler(op.value.opName);
                    const value = localValue.value;
                    return handler.prepare(value, op.value.value, local, message);
                },
                process: (op: IDirectoryValueTypeOperation, context, local, message) => {
                    const subdir = this.getWorkingDirectory(op.path);
                    const localValue = subdir ? subdir.getLocalValue<ValueTypeLocalValue>(op.key) : undefined;
                    const handler = localValue.getOpHandler(op.value.opName);
                    const previousValue = localValue.value;
                    handler.process(previousValue, op.value.value, context, local, message);
                    const event: IValueChanged = { key: op.key, previousValue };
                    this.emit("valueChanged", event, local, message);
                },
                submit: (op) => {
                    this.submitDirectoryMessage(op);
                },
            },
        );
    }
}

/**
 * Node of the directory tree.
 */
export class SubDirectory implements IDirectory {
    public [Symbol.toStringTag]: string = "SubDirectory";

    private readonly _storage: Map<string, ILocalValue> = new Map();
    private readonly _subdirectories: Map<string, SubDirectory> = new Map();
    private readonly pendingKeys: Map<string, number> = new Map();
    private readonly pendingSubDirectories: Map<string, number> = new Map();
    private pendingClearClientSequenceNumber: number = -1;

    /**
     * Constructor.
     * @param directory - reference back to the SharedDirectory to perform operations
     * @param absolutePath - the absolute path of this SubDirectory
     */
    constructor(
        private readonly directory: SharedDirectory,
        private readonly runtime: IComponentRuntime,
        public absolutePath: string) {
    }

    /**
     * Checks whether the given key exists in this SubDirectory.
     * @param key - the key to check
     */
    public has(key: string): boolean {
        return this._storage.has(key);
    }

    /**
     * Retrieves the given key from within this SubDirectory.
     * @param key - the key to retrieve
     */
    public get<T = any>(key: string): T {
        if (!this._storage.has(key)) {
            return undefined;
        }

        return this._storage.get(key).value as T;
    }

    public async wait<T = any>(key: string): Promise<T> {
        // Return immediately if the value already exists
        if (this._storage.has(key)) {
            return this._storage.get(key).value as T;
        }

        // Otherwise subscribe to changes
        return new Promise<T>((resolve, reject) => {
            const callback = (changed: IDirectoryValueChanged) => {
                if (this.absolutePath === changed.path && key === changed.key) {
                    resolve(this.get<T>(changed.key));
                    this.directory.removeListener("valueChanged", callback);
                }
            };

            this.directory.on("valueChanged", callback);
        });
    }

    /**
     * Sets the given key to the given value within this SubDirectory.
     * @param key - the key to set
     * @param value - the value to set the key to
     * @param type - value type
     */
    public set<T = any>(key: string, value: T, type?: string): this {
        let localValue: ILocalValue;
        let serializableValue: ISerializableValue;

        if (type && type !== ValueType[ValueType.Plain] && type !== ValueType[ValueType.Shared]) {
            // value is actually initialization params in the value type case
            localValue = this.directory.localValueMaker.makeValueType(
                type,
                this.directory.makeDirectoryValueOpEmitter(key, this.absolutePath),
                value,
            );

            // This is a special form of serialized valuetype only used for set, containing info for initialization.
            // After initialization, the serialized form will need to come from the .store of the value type's factory.
            serializableValue = { type, value };
        } else {
            localValue = this.directory.localValueMaker.fromInMemory(value);
            serializableValue = localValue.makeSerializable(
                this.runtime.IComponentSerializer,
                this.runtime.IComponentHandleContext,
                this.directory.handle);
        }

        this.setCore(
            key,
            localValue,
            true,
            null,
        );

        const op: IDirectorySetOperation = {
            key,
            path: this.absolutePath,
            type: "set",
            value: serializableValue,
        };
        this.submitKeyMessage(op);
        return this;
    }

    /**
     * Creates a SubDirectory with the given name as a child of this SubDirectory.
     * @param subdirName - name of the SubDirectory
     */
    public createSubDirectory(subdirName: string): SubDirectory {
        if (subdirName.indexOf(posix.sep) !== -1) {
            throw new Error(`SubDirectory names may not contain ${posix.sep}`);
        }

        this.createSubDirectoryCore(subdirName, true, null);

        const op: IDirectoryCreateSubDirectoryOperation = {
            path: this.absolutePath,
            subdirName,
            type: "createSubDirectory",
        };
        this.submitSubDirectoryMessage(op);

        return this._subdirectories.get(subdirName);
    }

    /**
     * Retrieves the given SubDirectory from within this SubDirectory.
     * @param subdirName - the name of the SubDirectory to retrieve
     */
    public getSubDirectory(subdirName: string): SubDirectory {
        return this._subdirectories.get(subdirName);
    }

    /**
     * Checks whether the given SubDirectory exists as a child of this SubDirectory.
     * @param subdirName - the name of the SubDirectory to check
     */
    public hasSubDirectory(subdirName: string): boolean {
        return this._subdirectories.has(subdirName);
    }

    /**
     * Deletes the given SubDirectory and all descendent keys and SubDirectories.
     * @param subdirName - the SubDirectory to delete
     */
    public deleteSubDirectory(subdirName: string): boolean {
        const op: IDirectoryDeleteSubDirectoryOperation = {
            path: this.absolutePath,
            subdirName,
            type: "deleteSubDirectory",
        };

        const successfullyRemoved = this.deleteSubDirectoryCore(subdirName, true, null);
        this.submitSubDirectoryMessage(op);
        return successfullyRemoved;
    }

    /**
     * Deletes the given key from within this SubDirectory.
     * @param key - the key to delete
     */
    public delete(key: string): boolean {
        const op: IDirectoryDeleteOperation = {
            key,
            path: this.absolutePath,
            type: "delete",
        };

        const successfullyRemoved = this.deleteCore(op.key, true, null);
        this.submitKeyMessage(op);
        return successfullyRemoved;
    }

    /**
     * Deletes all keys from within this SubDirectory.
     */
    public clear(): void {
        const op: IDirectoryClearOperation = {
            path: this.absolutePath,
            type: "clear",
        };

        this.clearCore(true, null);
        this.submitClearMessage(op);
    }

    /**
     * Issue a callback on each entry under this SubDirectory.
     * @param callback - callback to issue
     */
    public forEach(callback: (value: any, key: string, map: Map<string, any>) => void): void {
        this._storage.forEach((localValue, key, map) => {
            callback(localValue.value, key, map);
        });
    }

    /**
     * The number of entries under this SubDirectory.
     */
    public get size(): number {
        return this._storage.size;
    }

    /**
     * Get an iterator over the entries under this SubDirectory.
     */
    public entries(): IterableIterator<[string, any]> {
        const localEntriesIterator = this._storage.entries();
        const iterator = {
            next(): IteratorResult<[string, any]> {
                const nextVal = localEntriesIterator.next();
                if (nextVal.done) {
                    return { value: undefined, done: true };
                } else {
                    // unpack the stored value
                    return { value: [nextVal.value[0], nextVal.value[1].value], done: false };
                }
            },
            [Symbol.iterator]() {
                return this;
            },
        };
        return iterator;
    }

    /**
     * Get an iterator over the keys under this Subdirectory.
     */
    public keys(): IterableIterator<string> {
        return this._storage.keys();
    }

    /**
     * Get an iterator over the SubDirectories contained within this SubDirectory.
     */
    public subdirectories(): IterableIterator<[string, SubDirectory]> {
        return this._subdirectories.entries();
    }

    /**
     * Get an iterator over the values under this Subdirectory.
     */
    public values(): IterableIterator<any> {
        const localValuesIterator = this._storage.values();
        const iterator = {
            next(): IteratorResult<any> {
                const nextVal = localValuesIterator.next();
                if (nextVal.done) {
                    return { value: undefined, done: true };
                } else {
                    // unpack the stored value
                    return { value: nextVal.value.value, done: false };
                }
            },
            [Symbol.iterator]() {
                return this;
            },
        };
        return iterator;
    }

    /**
     * Get an iterator over the entries under this Subdirectory.
     */
    public [Symbol.iterator](): IterableIterator<[string, any]> {
        return this.entries();
    }

    /**
     * Get a SubDirectory within this SubDirectory, in order to use relative paths from that location.
     * @param path - Path of the SubDirectory to get, relative to this SubDirectory
     */
    public getWorkingDirectory(path: string): SubDirectory {
        return this.directory.getWorkingDirectory(this.makeAbsolute(path));
    }

    /**
     * @internal
     */
    public processClearMessage(
        op: IDirectoryClearOperation,
        context: ILocalValue,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): void {
        if (local) {
            if (this.pendingClearClientSequenceNumber === message.clientSequenceNumber) {
                this.pendingClearClientSequenceNumber = -1;
            }
            return;
        }
        this.clearExceptPendingKeys(this.pendingKeys);
        this.directory.emit("clear", local, op);
    }

    /**
     * @internal
     */
    public processDeleteMessage(
        op: IDirectoryDeleteOperation,
        context: ILocalValue,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): void {
        if (!this.needProcessStorageOperations(op, local, message)) {
            return;
        }
        this.deleteCore(op.key, local, message);
    }

    /**
     * @internal
     */
    public processSetMessage(
        op: IDirectorySetOperation,
        context: ILocalValue,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): void {
        if (!this.needProcessStorageOperations(op, local, message)) {
            return;
        }
        this.setCore(op.key, context, local, message);
    }

    /**
     * @internal
     */
    public processCreateSubDirectoryMessage(
        op: IDirectoryCreateSubDirectoryOperation,
        context: ILocalValue,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): void {
        if (!this.needProcessSubDirectoryOperations(op, local, message)) {
            return;
        }
        this.createSubDirectoryCore(op.subdirName, local, message);
    }

    /**
     * @internal
     */
    public processDeleteSubDirectoryMessage(
        op: IDirectoryDeleteSubDirectoryOperation,
        context: ILocalValue,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): void {
        if (!this.needProcessSubDirectoryOperations(op, local, message)) {
            return;
        }
        this.deleteSubDirectoryCore(op.subdirName, local, message);
    }

    /**
     * @internal
     */
    public submitClearMessage(op: IDirectoryClearOperation): void {
        const clientSequenceNumber = this.directory.submitDirectoryMessage(op);
        if (clientSequenceNumber !== -1) {
            this.pendingClearClientSequenceNumber = clientSequenceNumber;
        }
    }

    /**
     * @internal
     */
    public submitKeyMessage(op: IDirectoryKeyOperation): void {
        const clientSequenceNumber = this.directory.submitDirectoryMessage(op);
        if (clientSequenceNumber !== -1) {
            this.pendingKeys.set(op.key, clientSequenceNumber);
        }
    }

    /**
     * @internal
     */
    public submitSubDirectoryMessage(op: IDirectorySubDirectoryOperation): void {
        const clientSequenceNumber = this.directory.submitDirectoryMessage(op);
        if (clientSequenceNumber !== -1) {
            this.pendingSubDirectories.set(op.subdirName, clientSequenceNumber);
        }
    }

    /**
     * @internal
     */
    public getSerializableStorage(): {[key: string]: ISerializableValue} {
        if (this._storage.size === 0) {
            return undefined;
        }
        const serializedStorage: {[key: string]: ISerializableValue} = {};
        for (const [key, localValue] of this._storage) {
            serializedStorage[key] = localValue.makeSerializable(
                this.runtime.IComponentSerializer,
                this.runtime.IComponentHandleContext,
                this.directory.handle);
        }
        return serializedStorage;
    }

    /**
     * @internal
     */
    public populateStorage(key: string, localValue: ILocalValue) {
        this._storage.set(key, localValue);
    }

    /**
     * @internal
     */
    public getLocalValue<T extends ILocalValue = ILocalValue>(key: string): T {
        return this._storage.get(key) as T;
    }

    /**
     * Converts the given relative path into an absolute path.
     * @param path - relative path
     */
    private makeAbsolute(relativePath: string): string {
        return posix.resolve(this.absolutePath, relativePath);
    }

    private needProcessStorageOperations(
        op: IDirectoryKeyOperation,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): boolean {
        if (this.pendingClearClientSequenceNumber !== -1) {
            // If I have a NACK clear, we can ignore all ops.
            return false;
        }

        if ((this.pendingKeys.size !== 0 && this.pendingKeys.has(op.key))) {
            // Found an NACK op, clear it from the directory if the latest sequence number in the directory
            // match the message's and don't process the op.
            if (local) {
                const pendingKeyClientSequenceNumber = this.pendingKeys.get(op.key);
                if (pendingKeyClientSequenceNumber === message.clientSequenceNumber) {
                    this.pendingKeys.delete(op.key);
                }
            }
            return false;
        }

        // If we don't have a NACK op on the key, we need to process the remote ops.
        return !local;
    }

    private needProcessSubDirectoryOperations(
        op: IDirectorySubDirectoryOperation,
        local: boolean,
        message: ISequencedDocumentMessage,
    ): boolean {
        if (this.pendingSubDirectories.has(op.subdirName)) {
            if (local) {
                const pendingSubDirectoryClientSequenceNumber = this.pendingSubDirectories.get(op.subdirName);
                if (pendingSubDirectoryClientSequenceNumber === message.clientSequenceNumber) {
                    this.pendingSubDirectories.delete(op.subdirName);
                }
            }
            return false;
        }

        return !local;
    }

    private clearExceptPendingKeys(pendingKeys: Map<string, number>) {
        // Assuming the pendingKeys is small and the map is large
        // we will get the value for the pendingKeys and clear the map
        const temp = new Map<string, ILocalValue>();
        pendingKeys.forEach((value, key, map) => {
            temp.set(key, this._storage.get(key));
        });
        this._storage.clear();
        temp.forEach((value, key, map) => {
            this._storage.set(key, value);
        });
    }

    private clearCore(local: boolean, op: ISequencedDocumentMessage) {
        this._storage.clear();
        this.directory.emit("clear", local, op);
    }

    private deleteCore(key: string, local: boolean, op: ISequencedDocumentMessage) {
        const previousValue = this.get(key);
        const successfullyRemoved = this._storage.delete(key);
        if (successfullyRemoved) {
            const event: IDirectoryValueChanged = { key, path: this.absolutePath, previousValue };
            this.directory.emit("valueChanged", event, local, op);
        }
        return successfullyRemoved;
    }

    private setCore(key: string, value: ILocalValue, local: boolean, op: ISequencedDocumentMessage) {
        const previousValue = this.get(key);
        this._storage.set(key, value);
        const event: IDirectoryValueChanged = { key, path: this.absolutePath, previousValue };
        this.directory.emit("valueChanged", event, local, op);
    }

    private createSubDirectoryCore(subdirName: string, local: boolean, op: ISequencedDocumentMessage) {
        if (!this._subdirectories.has(subdirName)) {
            this._subdirectories.set(
                subdirName,
                new SubDirectory(this.directory, this.runtime, posix.join(this.absolutePath, subdirName)),
            );
        }
    }

    private deleteSubDirectoryCore(subdirName: string, local: boolean, op: ISequencedDocumentMessage) {
        // This should make the subdirectory structure unreachable so it can be GC'd and won't appear in snapshots
        // Might want to consider cleaning out the structure more exhaustively though?
        return this._subdirectories.delete(subdirName);
    }
}
