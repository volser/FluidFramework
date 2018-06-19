import { core } from "../client-api";
import { BaseWork} from "./baseWork";
import { IWork} from "./definitions";
import { Serializer } from "./serializer";

// Consider idle 5s of no activity. And snapshot if a minute has gone by with no snapshot.
const IdleDetectionTime = 5000;
const MaxTimeWithoutSnapshot = IdleDetectionTime * 12;
const SnapshotRetryTime = 1000;

export class SnapshotWork extends BaseWork implements IWork {
    constructor(docId: string, private token: string, config: any, private service: core.IDocumentService) {
        super(docId, config);
    }

    public async start(task: string): Promise<void> {
        await this.loadDocument(
            { encrypted: undefined, localMinSeq: 0, token: this.token, client: { type: "robot"} },
            this.service,
            task);
        const serializer = new Serializer(this.document, IdleDetectionTime, MaxTimeWithoutSnapshot, SnapshotRetryTime);
        const eventHandler = (op: core.ISequencedDocumentMessage) => {
            serializer.run(op);
        };
        this.operation = eventHandler;
        this.document.on("op", eventHandler);
        return Promise.resolve();
    }
}
