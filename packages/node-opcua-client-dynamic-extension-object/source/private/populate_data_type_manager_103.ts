/* eslint-disable max-statements */
// tslint:disable: no-console
/**
 * @module node-opcua-client-dynamic-extension-object
 */
import chalk from "chalk";

import { assert } from "node-opcua-assert";
import { AttributeIds, makeNodeClassMask, makeResultMask, NodeClassMask, QualifiedName } from "node-opcua-data-model";
import { checkDebugFlag, make_debugLog, make_errorLog, make_warningLog } from "node-opcua-debug";
import { ConstructorFuncWithSchema, DataTypeFactory, getStandardDataTypeFactory } from "node-opcua-factory";
import { ExpandedNodeId, NodeId, resolveNodeId, sameNodeId } from "node-opcua-nodeid";
import { browseAll, BrowseDescriptionLike, IBasicSessionAsync, IBasicSessionAsync2 } from "node-opcua-pseudo-session";
import {
    createDynamicObjectConstructor,
    DataTypeAndEncodingId,
    MapDataTypeAndEncodingIdProvider,
    parseBinaryXSD
} from "node-opcua-schemas";
import { BrowseDescriptionOptions, BrowseDirection, BrowseResult, ReferenceDescription } from "node-opcua-service-browse";
import { makeBrowsePath } from "node-opcua-service-translate-browse-path";
import { StatusCodes } from "node-opcua-status-code";
import { BrowsePath, ReadValueIdOptions, StructureDefinition } from "node-opcua-types";

import { ExtraDataTypeManager } from "../extra_data_type_manager";
import {
    CacheForFieldResolution,
    convertDataTypeDefinitionToStructureTypeSchema
} from "../convert_data_type_definition_to_structuretype_schema";
import { DataValue } from "node-opcua-data-value";

const doDebug = checkDebugFlag(__filename);
const debugLog = make_debugLog(__filename);
const errorLog = make_errorLog(__filename);
const warningLog = make_warningLog(__filename);

// DataType
//    | 1
//    | n
//    +- HasEncoding-> "Default Binary" (O)[DataTypeEncodingType]
//                           |
//                           +-- HasDescription -> "MyItemType" (V)[DataTypeDescriptionType]
//                                                    |
//                                                    +- ComponentOf -> Schema(V) []
//                                                                         |
//                                                                         +- ComponentOf -> OPC Binary(V)[DataTypeSystemType]
//
// Note that in 1.04 compliant server, DataType definition might be available
//           in a DataTypeDefinition attributes of the DataType object
//           However this is a brand new aspect of the specification and is not widely implemented
//           it is also optional
//           It will takes time for old opcua server to be refurbished and we may have to
//           keep the current method to access type definition from embedded xsd.
//

async function _readDeprecatedFlag(session: IBasicSessionAsync, dataTypeDictionary: NodeId): Promise<boolean> {
    const browsePath = makeBrowsePath(dataTypeDictionary, ".Deprecated");
    const a = await session.translateBrowsePath(browsePath);
    /* istanbul ignore next */
    if (!a.targets || a.targets.length === 0) {
        // the server is probably version < 1.04.
        debugLog("Cannot find Deprecated property for dataTypeDictionary " + dataTypeDictionary.toString());
        return false;
    }
    const deprecatedFlagNodeId = a.targets[0].targetId;
    const dataValue = await session.read({ nodeId: deprecatedFlagNodeId, attributeId: AttributeIds.Value });
    return dataValue.value.value;
}

async function _readNamespaceUriProperty(session: IBasicSessionAsync, dataTypeDictionary: NodeId): Promise<string> {
    const a = await session.translateBrowsePath(makeBrowsePath(dataTypeDictionary, ".NamespaceUri"));
    /* istanbul ignore next */
    if (!a.targets || a.targets.length === 0) {
        return "??dataTypeDictionary doesn't expose NamespaceUri property??";
    }
    const namespaceUriProp = a.targets[0].targetId;
    const dataValue = await session.read({ nodeId: namespaceUriProp, attributeId: AttributeIds.Value });
    return dataValue.value.value || "<not set>";
}

export interface IDataTypeDescription {
    browseName: QualifiedName;
    nodeId: NodeId;
    encodings?: DataTypeAndEncodingId;
    symbolicName?: string;
    isAbstract?: boolean;
}

async function _getDataTypeDescriptions(
    session: IBasicSessionAsync2,
    dataTypeDictionaryNodeId: NodeId
): Promise<IDataTypeDescription[]> {
    const nodeToBrowse2: BrowseDescriptionLike = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Variable"),
        nodeId: dataTypeDictionaryNodeId,
        referenceTypeId: resolveNodeId("HasComponent"),
        // resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
        resultMask: makeResultMask("NodeId | BrowseName")
    };
    const result2 = await browseAll(session, nodeToBrowse2);
    result2.references = result2.references || [];
    return result2.references.map((r) => ({ nodeId: r.nodeId, browseName: r.browseName }));
}

async function _enrichWithDescriptionOf(
    session: IBasicSessionAsync2,
    dataTypeDescriptions: IDataTypeDescription[]
): Promise<NodeId[]> {
    const nodesToBrowse3: BrowseDescriptionOptions[] =
        dataTypeDescriptions.map((dataTypeDescription) => ({
            browseDirection: BrowseDirection.Inverse,
            includeSubtypes: false,
            nodeClassMask: makeNodeClassMask("Object"),
            nodeId: dataTypeDescription.nodeId.toString(),
            referenceTypeId: resolveNodeId("HasDescription"),
            //            resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
            resultMask: makeResultMask("NodeId")
        }))
        ;

    /* istanbul ignore next */
    if (nodesToBrowse3.length === 0) {
        return [];
    }
    const results3 = await browseAll(session, nodesToBrowse3);

    const binaryEncodings = [];
    const nodesToBrowseDataType: BrowseDescriptionOptions[] = [];

    for (let i = 0; i < results3.length; i++) {
        const result3 = results3[i];
        const dataTypeDescription = dataTypeDescriptions[i];

        result3.references = result3.references || [];

        if (result3.references.length === 0) {
            // may be the dataType is abstract and as no need for DescriptionOF
            continue;
        }
        if (result3.references.length !== 1) {
            warningLog("_enrichWithDescriptionOf : expecting 1 reference for ", dataTypeDescription.browseName.toString());
            warningLog(result3.toString());
            continue;
        }
        for (const ref of result3.references) {
            const binaryEncodingNodeId = ref.nodeId;
            dataTypeDescription.encodings = dataTypeDescription.encodings || {
                binaryEncodingNodeId: NodeId.nullNodeId,
                dataTypeNodeId: NodeId.nullNodeId,
                jsonEncodingNodeId: NodeId.nullNodeId,
                xmlEncodingNodeId: NodeId.nullNodeId
            };
            dataTypeDescription.encodings.binaryEncodingNodeId = binaryEncodingNodeId;
            binaryEncodings.push(binaryEncodingNodeId);
            nodesToBrowseDataType.push({
                browseDirection: BrowseDirection.Inverse,
                includeSubtypes: false,
                nodeClassMask: NodeClassMask.DataType,
                nodeId: ref.nodeId,
                referenceTypeId: resolveNodeId("HasEncoding"),
                //            resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
                resultMask: makeResultMask("NodeId | BrowseName")
            });
        }
    }

    const dataTypeNodeIds: NodeId[] = [];

    if (nodesToBrowseDataType.length > 0) {
        const results4 = await browseAll(session, nodesToBrowseDataType);
        for (let i = 0; i < results4.length; i++) {
            const result4 = results4[i];
            result4.references = result4.references || [];

            /* istanbul ignore next */
            if (result4.references.length !== 1) {
                errorLog("What's going on ?", result4.toString(), "result4.references.length = ", result4.references.length);
            }

            const ref = result4.references![0];
            const dataTypeNodeId = ref.nodeId;
            dataTypeNodeIds[i] = dataTypeNodeId;
            const dataTypeDescription = dataTypeDescriptions[i];
            dataTypeDescription.encodings!.dataTypeNodeId = dataTypeNodeId;
        }
    }

    const otherEncodingBrowse = dataTypeNodeIds.map((dataTypeNodeId) => ({
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: NodeClassMask.Object,
        nodeId: dataTypeNodeId,
        referenceTypeId: resolveNodeId("HasEncoding"),
        //            resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
        resultMask: makeResultMask("NodeId | BrowseName")
    }));

    const results5 = await browseAll(session, otherEncodingBrowse);
    for (let i = 0; i < results5.length; i++) {
        const result5 = results5[i];
        const dataTypeDescription = dataTypeDescriptions[i];
        let encodingCounter = 0;
        for (const ref of result5.references || []) {
            switch (ref.browseName.name) {
                case "Default XML":
                    dataTypeDescription.encodings!.xmlEncodingNodeId = ref.nodeId;
                    encodingCounter++;
                    break;
                case "Default Binary":
                    dataTypeDescription.encodings!.binaryEncodingNodeId = ref.nodeId;
                    encodingCounter++;
                    break;
                case "Default JSON":
                    dataTypeDescription.encodings!.jsonEncodingNodeId = ref.nodeId;
                    encodingCounter++;
                    break;
                default:
                    errorLog("Cannot handle unknown encoding", ref.browseName.name);
            }
        }
        if (encodingCounter === 0) {
            dataTypeDescription.isAbstract = true;
        }
    }
    return dataTypeNodeIds;
}

interface IDataTypeDefInfo {
    className: string;
    dataTypeNodeId: NodeId;
    dataTypeDefinition: StructureDefinition;
    isAbstract: boolean;
}
type DataTypeDefinitions = IDataTypeDefInfo[];

function sortStructure(dataTypeDefinitions: DataTypeDefinitions) {
    const dataTypeDefinitionsSorted: IDataTypeDefInfo[] = [];
    const _visited: { [key: string]: IDataTypeDefInfo } = {};
    const _map: { [key: string]: IDataTypeDefInfo } = {};

    for (const d of dataTypeDefinitions) {
        _map[d.dataTypeNodeId.toString()] = d;
    }

    function _visit(d: IDataTypeDefInfo) {
        const hash = d.dataTypeNodeId.toString();
        if (_visited[hash]) {
            return;
        }
        _visited[hash] = d;
        const bbb = _map[d.dataTypeDefinition.baseDataType.toString()];
        if (bbb) {
            _visit(bbb);
        }

        for (const f of d.dataTypeDefinition.fields || []) {
            const ddd = _map[f.dataType.toString()];
            if (!ddd) {
                continue;
            }
            _visit(ddd);
        }

        dataTypeDefinitionsSorted.push(d);
    }
    for (const d of dataTypeDefinitions) {
        _visit(d);
    }
    return dataTypeDefinitionsSorted;
}

const readIsAbstract = async (session: IBasicSessionAsync, nodeId: NodeId): Promise<boolean> => {
    const dataValue = await session.read({ nodeId, attributeId: AttributeIds.IsAbstract });
    return dataValue.value.value;
};

async function _extractDataTypeDictionaryFromDefinition(
    session: IBasicSessionAsync2,
    dataTypeDictionaryNodeId: NodeId,
    dataTypeFactory: DataTypeFactory
) {
    assert(dataTypeFactory, "expecting a dataTypeFactory");

    const dataTypeDescriptions = await _getDataTypeDescriptions(session, dataTypeDictionaryNodeId);
    const dataTypeNodeIds = await _enrichWithDescriptionOf(session, dataTypeDescriptions);

    // now read DataTypeDefinition attributes of all the dataTypeNodeIds, this will only contains concrete structure
    const nodesToRead: ReadValueIdOptions[] = dataTypeNodeIds.map((nodeId: NodeId) => ({
        attributeId: AttributeIds.DataTypeDefinition,
        nodeId
    }));

    const cache: { [key: string]: CacheForFieldResolution } = {};
    const dataValuesWithDataTypeDefinition = nodesToRead.length > 0 ? await session.read(nodesToRead) : [];

    // in some circumstances like Euromap, this assert fails:
    // assert(dataValuesWithDataTypeDefinition.length === dataTypeDescriptions.length);

    const dataTypeDefinitions: DataTypeDefinitions = [];

    let index = 0;

    const promise: Promise<void>[] = [];
    for (const dataValue of dataValuesWithDataTypeDefinition) {
        const dataTypeNodeId = dataTypeNodeIds[index];
        const dataTypeDescription = dataTypeDescriptions[index];

        /* istanbul ignore else */
        if (dataValue.statusCode.isGood()) {
            const dataTypeDefinition = dataValue.value.value;

            if (dataTypeDefinition && dataTypeDefinition instanceof StructureDefinition) {
                const className = dataTypeDescription.browseName.name!;
                promise.push(
                    (async () => {
                        const isAbstract = await readIsAbstract(session, dataTypeNodeId);
                        dataTypeDefinitions.push({ className, dataTypeNodeId, dataTypeDefinition, isAbstract });
                    })()
                );
            }
        } else {
            debugLog(
                "dataTypeNodeId ",
                dataTypeNodeId.toString(),
                " has no DataTypeDescription attribute",
                dataValue.statusCode.toString()
            );
        }
        index++;
    }
    await Promise.all(promise);

    // to do put in logical order
    const dataTypeDefinitionsSorted = sortStructure(dataTypeDefinitions);
    // istanbul ignore next
    if (doDebug) {
        debugLog("order ", dataTypeDefinitionsSorted.map((a) => a.className + " " + a.dataTypeNodeId).join(" ->  "));
    }

    const promises2: Promise<void>[] = [];

    for (const { className, dataTypeNodeId, dataTypeDefinition, isAbstract } of dataTypeDefinitionsSorted) {
        promises2.push(
            (async () => {
                // istanbul ignore next
                if (doDebug) {
                    debugLog(chalk.yellow("--------------------------------------- "), className, dataTypeNodeId.toString());
                }
                if (dataTypeFactory.hasStructureByTypeName(className)) {
                    return; // this structure has already been seen
                }
                // now fill typeDictionary
                try {
                    const dataTypeDescription = dataTypeDescriptions.find((a) => a.nodeId.toString() === dataTypeNodeId.toString());
                    if (!dataTypeDefinition) {
                        throw new Error("cannot find dataTypeDefinition for " + dataTypeNodeId.toString());
                    }
                    const schema = await convertDataTypeDefinitionToStructureTypeSchema(
                        session,
                        dataTypeNodeId,
                        className,
                        dataTypeDefinition,
                        dataTypeDescription!, // for encodings
                        dataTypeFactory,
                        isAbstract,
                        cache
                    );

                    // istanbul ignore next
                    if (doDebug) {
                        debugLog(
                            chalk.red("Registering "),
                            chalk.cyan(className.padEnd(30, " ")),
                            schema.dataTypeNodeId.toString()
                        );
                    }
                    if (!isAbstract) {
                        const Constructor = createDynamicObjectConstructor(
                            schema,
                            dataTypeFactory
                        ) as unknown as ConstructorFuncWithSchema;
                        assert(Constructor.schema === schema);
                    } else {
                        // istanbul ignore next
                        if (doDebug) {
                            debugLog("Ignoring Abstract ", className);
                        }
                    }
                } catch (err) {
                    errorLog("Constructor verification err: ", (<Error>err).message);
                    errorLog("For this reason class " + className + " has not been registered");
                    errorLog(err);
                }
            })()
        );
    }
    await Promise.all(promises2);
}

async function _extractNodeIds(
    session: IBasicSessionAsync2,
    dataTypeDictionaryNodeId: NodeId
): Promise<MapDataTypeAndEncodingIdProvider> {
    const map: { [key: string]: DataTypeAndEncodingId } = {};

    const dataTypeDescriptions = await _getDataTypeDescriptions(session, dataTypeDictionaryNodeId);

    /* const dataTypeNodeIds =  */
    await _enrichWithDescriptionOf(session, dataTypeDescriptions);

    for (const dataTypeDescription of dataTypeDescriptions) {
        map[dataTypeDescription.browseName.name!.toString()] = dataTypeDescription.encodings!;
    }

    return {
        getDataTypeAndEncodingId(key: string): DataTypeAndEncodingId | null {
            return map[key] || null;
        }
    };
}

interface TypeDictionaryInfo {
    reference: ReferenceDescription;
    dataTypeDictionaryNodeId: NodeId;
    isDictionaryDeprecated: boolean;
    rawSchema: string;

    // key is xmlShortName, value is namespaceUri  ;
    dependencies: { [key: string]: string };
    targetNamespace: string;
}

function _isOldDataTypeDictionary(d: TypeDictionaryInfo) {
    const isDictionaryDeprecated = d.isDictionaryDeprecated; // await _readDeprecatedFlag(session, dataTypeDictionaryNodeId);
    const rawSchema = d.rawSchema; // DataValue = await session.read({ nodeId: dataTypeDictionaryNodeId, attributeId: AttributeIds.Value });
    return !isDictionaryDeprecated && rawSchema.length >= 0;
}
async function _extractDataTypeDictionary(
    session: IBasicSessionAsync2,
    d: TypeDictionaryInfo,
    dataTypeManager: ExtraDataTypeManager
): Promise<void> {
    const dataTypeDictionaryNodeId = d.reference.nodeId;

    if (!_isOldDataTypeDictionary(d)) {
        if (doDebug) {
            const [name, namespace] = await Promise.all([
                session.read({ nodeId: dataTypeDictionaryNodeId, attributeId: AttributeIds.BrowseName }),
                _readNamespaceUriProperty(session, dataTypeDictionaryNodeId)
            ]);
            doDebug &&
                debugLog(
                    "DataTypeDictionary is deprecated or BSD schema stored in dataValue is null !",
                    chalk.cyan(name.value.value.toString()),
                    "namespace =",
                    namespace
                );
            debugLog("let's use the new way (1.04) and let's explore all dataTypes exposed by this name space");
        }
        // dataType definition in store directly in UADataType under the definition attribute
        const dataTypeFactory2 = dataTypeManager.getDataTypeFactory(dataTypeDictionaryNodeId.namespace);
        if (!dataTypeFactory2) {
            throw new Error("cannot find dataTypeFactory for namespace " + dataTypeDictionaryNodeId.namespace);
        }
        await _extractDataTypeDictionaryFromDefinition(session, dataTypeDictionaryNodeId, dataTypeFactory2);
    } else {
        const rawSchema = d.rawSchema; // DataValue = await session.read({ nodeId: dataTypeDictionaryNodeId, attributeId: AttributeIds.Value });
        doDebug &&
            debugLog(
                " ----- Using old method for extracting schema => with BSD files -----",
                dataTypeDictionaryNodeId.namespaceUri
            );
        // old method ( until 1.03 )
        // one need to read the schema file store in the dataTypeDictionary node and parse it !
        /* istanbul ignore next */
        if (doDebug) {
            debugLog("---------------------------------------------");
            debugLog(rawSchema.toString());
            debugLog("---------------------------------------------");
        }
        const idProvider = await _extractNodeIds(session, dataTypeDictionaryNodeId);
        const dataTypeFactory1 = dataTypeManager.getDataTypeFactory(dataTypeDictionaryNodeId.namespace);
        await parseBinaryXSD(rawSchema, idProvider, dataTypeFactory1);
    }
}

async function _exploreDataTypeDefinition(
    session: IBasicSessionAsync2,
    dataTypeDictionaryTypeNode: NodeId,
    dataTypeFactory: DataTypeFactory,
    namespaces: string[]
) {
    const nodeToBrowse: BrowseDescriptionLike = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Variable"),
        nodeId: dataTypeDictionaryTypeNode,
        referenceTypeId: resolveNodeId("HasComponent"),
        resultMask: makeResultMask("ReferenceType | IsForward | BrowseName | NodeClass | TypeDefinition")
    };
    const result = await browseAll(session, nodeToBrowse);
    const references = result.references || [];

    /* istanbul ignore next */
    if (references.length === 0) {
        return;
    }

    // request the Definition of each nodes
    const nodesToBrowse2 = references.map((ref: ReferenceDescription) => {
        return {
            browseDirection: BrowseDirection.Inverse,
            includeSubtypes: false,
            nodeClassMask: makeNodeClassMask("Object | Variable"),
            nodeId: ref.nodeId,
            referenceTypeId: resolveNodeId("HasDescription"),
            resultMask: makeResultMask("NodeId | ReferenceType | BrowseName | NodeClass | TypeDefinition")
        };
    });
    const results2 = await browseAll(session, nodesToBrowse2);

    const binaryEncodingNodeIds = results2.map((br: BrowseResult) => {
        const defaultBin = br.references!.filter((r: ReferenceDescription) => r.browseName.toString() === "Default Binary");

        /* istanbul ignore next */
        if (defaultBin.length < 1) {
            return ExpandedNodeId;
        }
        return ExpandedNodeId.fromNodeId(defaultBin[0].nodeId, namespaces[defaultBin[0].nodeId.namespace]);
    });

    // follow now Default Binary <= [Has Encoding] = [DataType]

    /* istanbul ignore next */
    if (doDebug) {
        debugLog(chalk.bgWhite.red("testing new constructors"));
        for (let i = 0; i < references.length; i++) {
            const ref = references[i];
            const binaryEncoding = binaryEncodingNodeIds[i];
            const name = ref.browseName!.name!.toString();
            debugLog("      type ", name.padEnd(30, " "), binaryEncoding.toString());
            // let's verify that constructor is operational
            try {
                const structureInfo = dataTypeFactory.getStructureInfoByTypeName(name);
                if (structureInfo.schema.isAbstract) {
                    continue;
                }
                const Constructor = structureInfo.constructor;
                if (!Constructor) {
                    throw new Error(`Cannot instantiate abstract DataType(name=${name})`);
                }
                // xx const constructor = getOrCreateConstructor(name, dataTypeFactory, defaultBinary);
                const testObject = new Constructor();
                debugLog(testObject.toString());
            } catch (err) {
                debugLog("         Error cannot construct Extension Object " + name);
                debugLog("         " + (<Error>err).message);
            }
        }
    }
}

const regexTargetNamespaceAttribute = /TargetNamespace="([^"]+)"|TargetNamespace='([^']+)'/;
function extractTargetNamespaceAttribute(xmlElement: string): string {
    // warning TargetNamespace could have ' or " , Wago PLC for instance uses simple quotes
    const c2 = xmlElement.match(regexTargetNamespaceAttribute);
    if (c2) {
        return c2[1] || c2[2];
    }
    return "";
}
const regexNamespaceRef = /xmlns:(.*)=(("([^"]+)")|('([^']+)'))/;
function extraNamespaceRef(attribute: string): { xmlns: string; namespace: string } | null {
    const c = attribute.match(regexNamespaceRef);
    if (c) {
        const xmlns = c[1] as string;
        const namespace: string = c[4] || c[5];
        return { xmlns, namespace };
    }
    return null;
}

/**
 * Extract all custom dataType
 * @param session
 * @param dataTypeManager
 */
export async function populateDataTypeManager103(
    session: IBasicSessionAsync2,
    dataTypeManager: ExtraDataTypeManager
): Promise<void> {
    debugLog("in ... populateDataTypeManager");

    // read namespace array
    const dataValueNamespaceArray = await session.read({
        attributeId: AttributeIds.Value,
        nodeId: resolveNodeId("Server_NamespaceArray")
    });

    let namespaceArray: string[] = dataValueNamespaceArray.value.value;

    // istanbul ignore next
    if (!namespaceArray) {
        debugLog("session: cannot read Server_NamespaceArray");
        // throw new Error("Cannot get Server_NamespaceArray as a array of string");
        return;
    }

    // istanbul ignore next
    if (doDebug) {
        debugLog("namespaceArray ", namespaceArray.map((a, index) => " " + index.toString().padEnd(3) + ":" + a).join(" "));
    }

    if (dataValueNamespaceArray.statusCode.isGood() && namespaceArray && namespaceArray.length > 0) {
        dataTypeManager.setNamespaceArray(namespaceArray);

        for (let namespaceIndex = 1; namespaceIndex < namespaceArray.length; namespaceIndex++) {
            if (!dataTypeManager.hasDataTypeFactory(namespaceIndex)) {
                const dataTypeFactory1 = new DataTypeFactory([getStandardDataTypeFactory()]);
                dataTypeManager.registerDataTypeFactory(namespaceIndex, dataTypeFactory1);
            }
        }
    }

    /// to do :: may be not useful
    if (!dataValueNamespaceArray.value.value && dataTypeManager.namespaceArray.length === 0) {
        dataTypeManager.setNamespaceArray([]);
    }

    const dataTypeDictionaryType = resolveNodeId("DataTypeDictionaryType");
    // DataType/OPCBinary => i=93 [OPCBinarySchema_TypeSystem]

    // "OPC Binary"[DataSystemType]
    const opcBinaryNodeId = resolveNodeId("OPCBinarySchema_TypeSystem");

    // let find all DataType dictionary node corresponding to a given namespace
    // (have DataTypeDictionaryType)
    const nodeToBrowse: BrowseDescriptionLike = {
        browseDirection: BrowseDirection.Forward,
        includeSubtypes: false,
        nodeClassMask: makeNodeClassMask("Variable"),
        nodeId: opcBinaryNodeId,
        referenceTypeId: resolveNodeId("HasComponent"),
        resultMask: makeResultMask("ReferenceType | IsForward | BrowseName | NodeClass | TypeDefinition")
    };
    const result = await browseAll(session, nodeToBrowse);

    // istanbul ignore next
    if (doDebug) {
        debugLog(result.statusCode.toString());
        debugLog(result.references?.map((r: any) => r.browseName?.toString()).join(" "));
    }

    // filter nodes that have the expected namespace Index
    // ( more specifically we want to filter out DataStructure from namespace 0)
    // we also want to keep only object of type DataTypeDictionaryType
    const references = result.references!.filter(
        (e: ReferenceDescription) => e.nodeId.namespace !== 0 && sameNodeId(e.typeDefinition, dataTypeDictionaryType)
    );

    debugLog(`found ${references.length} dictionaries`);

    async function putInCorrectOrder(): Promise<TypeDictionaryInfo[]> {
        const infos: TypeDictionaryInfo[] = [];
        const innerMap: { [key: string]: TypeDictionaryInfo } = {};

        const innerF = async (reference: ReferenceDescription) => {
            const dataTypeDictionaryNodeId = reference.nodeId;

            const promises: [Promise<boolean>, Promise<DataValue>] = [
                /* isDictionaryDeprecated: bool = await */ _readDeprecatedFlag(session, dataTypeDictionaryNodeId),
                /* rawSchemaDataValue!: DataValue = await */ session.read({
                attributeId: AttributeIds.Value,
                nodeId: dataTypeDictionaryNodeId
            })
            ];

            const [isDictionaryDeprecated, rawSchemaDataValue] = await Promise.all(promises);

            const rawSchema = rawSchemaDataValue.value.value ? rawSchemaDataValue.value.value.toString() : "";

            const info: TypeDictionaryInfo = {
                dataTypeDictionaryNodeId,
                dependencies: {},
                isDictionaryDeprecated,
                rawSchema,
                reference,
                targetNamespace: ""
            };

            infos.push(info);

            if (!isDictionaryDeprecated || rawSchema.length > 0) {
                // istanbul ignore next
                if (doDebug) {
                    debugLog("schema", rawSchema);
                }
                const matches = rawSchema.match(/<opc:TypeDictionary([^>]+)>/);
                if (matches) {
                    // extract xml:NS="namespace" from attribute list
                    // for instance:
                    //      <opc:TypeDictionary
                    //                xmlns:opc="http://opcfoundation.org/BinarySchema/"
                    //                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                    //                xmlns:ua="http://opcfoundation.org/UA/"
                    //                xmlns:tns="urn:SomeName:Ua:Types:GlobalTypes"
                    //                DefaultByteOrder="LittleEndian"
                    //                TargetNamespace="urn:SomeName:Ua:Types:GlobalTypes">
                    const typeDictionaryElementAttributes = matches[1];

                    info.targetNamespace = extractTargetNamespaceAttribute(typeDictionaryElementAttributes);

                    const nsKeyNamespace: { [key: string]: string } = {};
                    for (const attribute of typeDictionaryElementAttributes.split(" ")) {
                        const r = extraNamespaceRef(attribute);
                        if (r) {
                            const { xmlns, namespace } = r;
                            nsKeyNamespace[xmlns] = namespace;
                            debugLog("xxxx ns= ", xmlns, "=>", namespace);
                        }
                    }
                    info.dependencies = nsKeyNamespace;
                    debugLog("xxx targetNamespace = ", info.targetNamespace);
                    innerMap[info.targetNamespace] = info;
                }
            } else {
                // may be 1.04 => the rawSchema is no more needed in new version
                info.targetNamespace = namespaceArray[dataTypeDictionaryNodeId.namespace];
                debugLog("xxx targetNamespace = ", info.targetNamespace);
                innerMap[info.targetNamespace] = info;
            }
            // assert(info.targetNamespace.length !== 0);
        };
        const promises: Promise<void>[] = references.map(innerF);
        await Promise.all(promises);

        // ----------------------------------
        const orderedList: TypeDictionaryInfo[] = [];
        const visited: any = {};
        function explore(d: TypeDictionaryInfo): void {
            if (visited[d.targetNamespace]) {
                return;
            }
            visited[d.targetNamespace] = 1;
            for (const [xmlns, namespace] of Object.entries(d.dependencies)) {
                if (!innerMap[namespace] || namespace === d.targetNamespace) {
                    continue;
                }
                explore(innerMap[namespace]);
            }
            orderedList.push(d);
        }
        for (const d of infos) {
            explore(d);
        }

        debugLog(" Ordered List = ", orderedList.map((a) => a.targetNamespace).join("  "));

        return orderedList;
    }
    const dataTypeDictionaryInfo = await putInCorrectOrder();

    // setup dependencies
    const map: { [key: string]: TypeDictionaryInfo } = {};
    const map2: { [key: string]: DataTypeFactory[] } = {};
    for (const d of dataTypeDictionaryInfo) {
        map[d.targetNamespace] = d;

        doDebug &&
            debugLog(
                " fixing based dataTypeFactory dependencies for  ",
                d.targetNamespace,
                "index = ",
                d.dataTypeDictionaryNodeId.namespace
            );

        const baseDataFactories: DataTypeFactory[] = [getStandardDataTypeFactory()];
        for (const namespace of Object.values(d.dependencies)) {
            if (namespace === d.targetNamespace) {
                continue;
            }
            const baseDataFactory = map[namespace];
            if (!baseDataFactory) {
                continue;
            }
            const namespaceIndex = baseDataFactory.dataTypeDictionaryNodeId.namespace;
            if (dataTypeManager.hasDataTypeFactory(namespaceIndex)) {
                const dep = dataTypeManager.getDataTypeFactory(namespaceIndex);
                baseDataFactories.push(dep);
                doDebug &&
                    debugLog(
                        "   considering , ",
                        baseDataFactory.targetNamespace,
                        "index = ",
                        baseDataFactory.dataTypeDictionaryNodeId.namespace
                    );
            }
        }
        doDebug && debugLog("    baseDataFactories = ", baseDataFactories.map((f) => f.targetNamespace).join(" "));
        map2[d.targetNamespace] = baseDataFactories;
    }

    namespaceArray = dataTypeManager.namespaceArray;

    for (const d of dataTypeDictionaryInfo) {
        const set = new Set<DataTypeFactory>();
        set.add(getStandardDataTypeFactory());

        var visited: Set<string> = new Set();
        function explore(d: TypeDictionaryInfo): void {
            if (visited.has(d.targetNamespace)) {
                return;
            }
            visited.add(d.targetNamespace);

            for (const namespaceUri of Object.values(d.dependencies)) {
                if (visited.has(namespaceUri)) {
                    continue;
                }
                if (namespaceUri === d.targetNamespace) {
                    continue;
                }
                var index = namespaceArray.indexOf(namespaceUri);
                if (index == -1) continue;

                var dd = dataTypeManager.getDataTypeFactory(index);
                set.add(dd);

                const base = map[namespaceUri];
                if (base) {
                    explore(base);
                }
            }
        }
        explore(d);
        const baseDataFactories = Array.from(set);
        const dataTypeFactory = dataTypeManager.getDataTypeFactory(d.dataTypeDictionaryNodeId.namespace);
        if (dataTypeFactory) {
            dataTypeFactory.repairBaseDataFactories(baseDataFactories);
        }
    }
    // --------------------

    // now investigate DataTypeDescriptionType
    async function processReferenceOnDataTypeDictionaryType(d: TypeDictionaryInfo): Promise<void> {
        debugLog(chalk.cyan("processReferenceOnDataTypeDictionaryType on  "), d.targetNamespace);
        const ref = d.reference;
        const dataTypeDictionaryNodeId = d.reference.nodeId;

        await _extractDataTypeDictionary(session, d, dataTypeManager);
        /* istanbul ignore next */
        if (doDebug) {
            debugLog(
                chalk.bgWhite("                                         => "),
                ref.browseName.toString(),
                ref.nodeId.toString()
            );
        }
        const dataTypeFactory = dataTypeManager.getDataTypeFactoryForNamespace(dataTypeDictionaryNodeId.namespace);
        await _exploreDataTypeDefinition(session, dataTypeDictionaryNodeId, dataTypeFactory, dataTypeManager.namespaceArray);
    }

    // istanbul ignore next
    if (doDebug) {
        for (const d of dataTypeDictionaryInfo) {
            debugLog(d);
        }
    }


    // https://medium.com/swlh/dealing-with-multiple-promises-in-javascript-41d6c21f20ff
    if (false) {
        // we need to read sequentially the dataTypeDictionaryInfo
        // to esnsure that dependencies are resolved in the correct order
        for (const d of dataTypeDictionaryInfo) {
            await processReferenceOnDataTypeDictionaryType(d);
        }
    } else {
        // attempt to load all dataTypeDictionary in parallel as much as possible
        // by ensuring parallel operation happens only when dependencies are resolved
        const alreadyProcessed = new Set<string>();
        alreadyProcessed.add("http://opcfoundation.org/UA/");
        alreadyProcessed.add("http://www.w3.org/2001/XMLSchema-instance");
        alreadyProcessed.add("http://opcfoundation.org/BinarySchema/");

        const unquote = (s: string) => {
            // remove starting and ending ' or " if any ...
            if (s.startsWith("'") || s.startsWith('"')) {
                s = s.substring(1);
            }
            if (s.endsWith("'") || s.endsWith('"')) {
                s = s.substring(0, s.length - 1);
            }
            return s;
        }
        // check if all dependencies have been processed for this dataTypeDictionary
        const allDependenciesAlreadyProcessed = (typeDictionaryInfo: TypeDictionaryInfo) => {

            for (const [key, namespace1] of Object.entries(typeDictionaryInfo.dependencies)) {
                // codesys may add quotes around the namespace
                const namespace = unquote(namespace1);
                if (typeDictionaryInfo.targetNamespace === namespace) {
                    continue;
                }
                if (!alreadyProcessed.has(namespace)) {
                    doDebug && debugLog(alreadyProcessed.values(), "vs", namespace);
                    return false;
                }
            }
            return true;
        }

        const queue: TypeDictionaryInfo[] = [...dataTypeDictionaryInfo];

        // we load typeDictionary in parallel by processing all 
        // typeDictionary that have all their dependencies resolved
        const extractIndependantTypeInfo = (queue: TypeDictionaryInfo[]): TypeDictionaryInfo[] => {
            const toProcess = queue.splice(0);
            const result: TypeDictionaryInfo[] = [];
            for (const typeDictionaryInfo of toProcess) {
                if (allDependenciesAlreadyProcessed(typeDictionaryInfo)) {
                    // extract this typeDictionaryInfo
                    result.push(typeDictionaryInfo);
                } else {
                    // keep it for later
                    queue.push(typeDictionaryInfo);
                }
            }
            return result;
        }
        const processFunc = async (typeDictionaryInfo: TypeDictionaryInfo) => {
            try {
                doDebug && debugLog("processing ", typeDictionaryInfo.targetNamespace);
                await processReferenceOnDataTypeDictionaryType(typeDictionaryInfo);
            } catch (err) {
                errorLog("Error in processReferenceOnDataTypeDictionaryType", err);
            }
            alreadyProcessed.add(unquote(typeDictionaryInfo.targetNamespace));
        }
        while (queue.length > 0) {

            // istanbul ignore next
            if (doDebug) {
                for (const d of queue) {
                    debugLog({ t: d.targetNamespace, d: d.dependencies });
                }
            }

            doDebug && debugLog("queue length = ", queue.length);

            const readyToProcess = extractIndependantTypeInfo(queue);
            if (readyToProcess.length === 0) {
                // we are stuck
                errorLog("Cannot process any more dataTypeDictionary");
                break;
            }
            const promises: Promise<void>[] =
                readyToProcess.map((typeDictionaryInfo) => processFunc(typeDictionaryInfo));
            await Promise.all(promises);
        }
    }
    debugLog("out ... populateDataTypeManager103");
}
