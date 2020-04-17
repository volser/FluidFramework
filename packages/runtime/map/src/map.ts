/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { fromBase64ToUtf8 } from "@microsoft/fluid-common-utils";
import { addBlobToTree } from "@microsoft/fluid-protocol-base";
import {
    ISequencedDocumentMessage,
    ITree,
    MessageType,
} from "@microsoft/fluid-protocol-definitions";
import {
    IChannelAttributes,
    IComponentRuntime,
    IObjectStorageService,
    ISharedObjectServices,
} from "@microsoft/fluid-runtime-definitions";
import {
    ISharedObjectFactory,
    SharedObject,
} from "@microsoft/fluid-shared-object-base";
import { debug } from "./debug";
import {
    ISharedMap,
    ISharedMapEvents,
} from "./interfaces";
import {
    valueTypes,
} from "./localValues";
import { IMapDataObjectSerializable, MapKernel } from "./mapKernel";
import { pkgVersion } from "./packageVersion";

interface IMapSerializationFormat {
    blobs?: string[];
    content: IMapDataObjectSerializable;
}

const snapshotFileName = "header";

/**
 * The factory that defines the map.
 * @sealed
 */
export class MapFactory implements ISharedObjectFactory {
    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#ISharedObjectFactory."type"}
   */
    public static readonly Type = "https://graph.microsoft.com/types/map";

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#ISharedObjectFactory.attributes}
   */
    public static readonly Attributes: IChannelAttributes = {
        type: MapFactory.Type,
        snapshotFormatVersion: "0.2",
        packageVersion: pkgVersion,
    };

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#ISharedObjectFactory."type"}
   */
    public get type() {
        return MapFactory.Type;
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#ISharedObjectFactory.attributes}
   */
    public get attributes() {
        return MapFactory.Attributes;
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#ISharedObjectFactory.load}
   */
    public async load(
        runtime: IComponentRuntime,
        id: string,
        services: ISharedObjectServices,
        branchId: string,
        attributes: IChannelAttributes): Promise<ISharedMap> {

        const map = new SharedMap(id, runtime, attributes);
        await map.load(branchId, services);

        return map;
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#ISharedObjectFactory.create}
   */
    public create(runtime: IComponentRuntime, id: string): ISharedMap {
        const map = new SharedMap(id, runtime, MapFactory.Attributes);
        map.initializeLocal();

        return map;
    }
}

/**
 * A SharedMap is a map-like distributed data structure.
 */
export class SharedMap extends SharedObject<ISharedMapEvents> implements ISharedMap {
    /**
   * Create a new shared map.
   * @param runtime - Component runtime the new shared map belongs to
   * @param id - Optional name of the shared map
   * @returns Newly create shared map (but not attached yet)
   */
    public static create(runtime: IComponentRuntime, id?: string): SharedMap {
        return runtime.createChannel(id, MapFactory.Type) as SharedMap;
    }

    /**
   * Get a factory for SharedMap to register with the component.
   * @returns A factory that creates and load SharedMap
   */
    public static getFactory(): ISharedObjectFactory {
        return new MapFactory();
    }

    /**
   * String representation for the class.
   */
    public readonly [Symbol.toStringTag]: string = "SharedMap";

    /**
   * MapKernel which manages actual map operations.
   */
    private readonly kernel: MapKernel;

    /**
   * Create a new SharedMap.
   * @param id - String identifier
   * @param runtime - Component runtime
   * @param attributes - The attributes for the map
   */
    constructor(
        id: string,
        runtime: IComponentRuntime,
        attributes: IChannelAttributes,
    ) {
        super(id, runtime, attributes);
        this.kernel = new MapKernel(
            runtime,
            this.handle,
            (op) => this.submitLocalMessage(op),
            valueTypes,
            this,
        );
    }

    /**
   * {@inheritDoc MapKernel.keys}
   */
    public keys(): IterableIterator<string> {
        return this.kernel.keys();
    }

    /**
   * {@inheritDoc MapKernel.entries}
   */
    public entries(): IterableIterator<[string, any]> {
        return this.kernel.entries();
    }

    /**
   * {@inheritDoc MapKernel.values}
   */
    public values(): IterableIterator<any> {
        return this.kernel.values();
    }

    /**
   * Get an iterator over the entries in this map.
   * @returns The iterator
   */
    public [Symbol.iterator](): IterableIterator<[string, any]> {
        return this.kernel.entries();
    }

    /**
   * {@inheritDoc MapKernel.size}
   */
    public get size() {
        return this.kernel.size;
    }

    /**
   * {@inheritDoc MapKernel.forEach}
   */
    public forEach(callbackFn: (value: any, key: string, map: Map<string, any>) => void): void {
        this.kernel.forEach(callbackFn);
    }

    /**
   * {@inheritDoc ISharedMap.get}
   */
    public get<T = any>(key: string): T {
        return this.kernel.get<T>(key);
    }

    /**
   * {@inheritDoc ISharedMap.wait}
   */
    public async wait<T = any>(key: string): Promise<T> {
        return this.kernel.wait<T>(key);
    }

    /**
   * {@inheritDoc MapKernel.has}
   */
    public has(key: string): boolean {
        return this.kernel.has(key);
    }

    /**
   * {@inheritDoc ISharedMap.set}
   */
    public set(key: string, value: any): this {
        this.kernel.set(key, value);
        return this;
    }

    /**
   * {@inheritDoc IValueTypeCreator.createValueType}
   */
    public createValueType(key: string, type: string, params: any): this {
        this.kernel.createValueType(key, type, params);
        return this;
    }

    /**
   * {@inheritDoc MapKernel.delete}
   */
    public delete(key: string): boolean {
        return this.kernel.delete(key);
    }

    /**
   * {@inheritDoc MapKernel.clear}
   */
    public clear(): void {
        this.kernel.clear();
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#SharedObject.snapshot}
   */
    public snapshot(): ITree {
        let currentSize = 0;
        let counter = 0;
        let headerBlob: IMapDataObjectSerializable = {};
        const blobs: string[] = [];

        const tree: ITree = {
            entries: [],
            id: null,
        };

        const data = this.kernel.getSerializedStorage();

        // If single property exceeds this size, it goes into its own blob
        const MinValueSizeSeparateSnapshotBlob = 8 * 1024;

        // Maximum blob size for multiple map properties
        // Should be bigger than MinValueSizeSeparateSnapshotBlob
        const MaxSnapshotBlobSize = 16 * 1024;

        // Partitioning algorithm:
        // 1) Split large (over MinValueSizeSeparateSnapshotBlob = 8K) properties into their own blobs.
        //    Naming (across snapshots) of such blob does not have to be stable across snapshots,
        //    As de-duping process (in driver) should not care about paths, only content.
        // 2) Split remaining properties into blobs of MaxSnapshotBlobSize (16K) size.
        //    This process does not produce stable partitioning. This means
        //    modification (including addition / deletion) of property can shift properties across blobs
        //    and result in non-incremental snapshot.
        //    This can be improved in the future, without being format breaking change, as loading sequence
        //    loads all blobs at once and partitioning schema has no impact on that process.
        for (const key of Object.keys(data)) {
            const value = data[key];
            if (value.value && value.value.length >= MinValueSizeSeparateSnapshotBlob) {
                const blobName = `blob${counter}`;
                counter++;
                blobs.push(blobName);
                const content: IMapDataObjectSerializable = {
                    [key]: {
                        type: value.type,
                        value: JSON.parse(value.value),
                    },
                };
                addBlobToTree(tree, blobName, content);
            } else {
                currentSize += value.type.length + 21; // Approximation cost of property header
                if (value.value) {
                    currentSize += value.value.length;
                }

                if (currentSize > MaxSnapshotBlobSize) {
                    const blobName = `blob${counter}`;
                    counter++;
                    blobs.push(blobName);
                    addBlobToTree(tree, blobName, headerBlob);
                    headerBlob = {};
                    currentSize = 0;
                }
                headerBlob[key] = {
                    type: value.type,
                    value: value.value === undefined ? undefined : JSON.parse(value.value),
                };

            }
        }

        const header: IMapSerializationFormat = {
            blobs,
            content: headerBlob,
        };
        addBlobToTree(tree, snapshotFileName, header);

        return tree;
    }

    public getSerializableStorage(): IMapDataObjectSerializable {
        return this.kernel.getSerializableStorage();
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#SharedObject.loadCore}
   */
    protected async loadCore(
        branchId: string,
        storage: IObjectStorageService) {

        const header = await storage.read(snapshotFileName);

        const data = fromBase64ToUtf8(header);
        const json = JSON.parse(data) as object;
        const newFormat = json as IMapSerializationFormat;
        if (Array.isArray(newFormat.blobs)) {
            this.kernel.populateFromSerializable(newFormat.content);
            await Promise.all(newFormat.blobs.map(async (value) => {
                const blob = await storage.read(value);
                const blobData = fromBase64ToUtf8(blob);
                this.kernel.populateFromSerializable(JSON.parse(blobData) as IMapDataObjectSerializable);
            }));
        } else {
            this.kernel.populateFromSerializable(json as IMapDataObjectSerializable);
        }
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#SharedObject.onDisconnect}
   */
    protected onDisconnect() {
        debug(`Map ${this.id} is now disconnected`);
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#SharedObject.onConnect}
   */
    protected onConnect(pending: any[]) {
        debug(`Map ${this.id} is now connected`);

        for (const message of pending) {
            this.kernel.trySubmitMessage(message);
        }
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#SharedObject.processCore}
   */
    protected processCore(message: ISequencedDocumentMessage, local: boolean) {
        if (message.type === MessageType.Operation) {
            this.kernel.tryProcessMessage(message, local);
        }
    }

    /**
   * {@inheritDoc @microsoft/fluid-shared-object-base#SharedObject.registerCore}
   */
    protected registerCore() {
        for (const value of this.values()) {
            if (SharedObject.is(value)) {
                value.register();
            }
        }
    }
}
