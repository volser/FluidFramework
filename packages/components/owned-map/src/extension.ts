/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ISharedMap, IValueType } from "@prague/map";
import { IComponentRuntime, ISharedObjectServices } from "@prague/runtime-definitions";
import { ISharedObjectExtension } from "@prague/shared-object-common";
import { OwnedSharedMap } from "./ownedMap";

/**
 * The extension that defines the map
 */
export class OwnedMapExtension implements ISharedObjectExtension {
    public static Type = "https://graph.microsoft.com/types/ownedmap";

    public readonly type: string = OwnedMapExtension.Type;
    public readonly snapshotFormatVersion: string = "0.1";

    constructor(private readonly defaultValueTypes: Array<IValueType<any>> = []) {
    }

    public async load(
        runtime: IComponentRuntime,
        id: string,
        minimumSequenceNumber: number,
        services: ISharedObjectServices,
        headerOrigin: string): Promise<ISharedMap> {

        const map = new OwnedSharedMap(id, runtime, OwnedMapExtension.Type);
        this.registerValueTypes(map);
        await map.load(minimumSequenceNumber, headerOrigin, services);

        return map;
    }

    public create(document: IComponentRuntime, id: string): ISharedMap {
        const map = new OwnedSharedMap(id, document, OwnedMapExtension.Type);
        this.registerValueTypes(map);
        map.initializeLocal();

        return map;
    }

    private registerValueTypes(map: OwnedSharedMap) {
        for (const type of this.defaultValueTypes) {
            map.registerValueType(type);
        }
    }
}
