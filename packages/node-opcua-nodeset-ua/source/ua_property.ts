// ----- this file has been automatically generated - do not edit
import { UAVariableT } from "node-opcua-address-space-base"
import { DataType } from "node-opcua-variant"
/**
 * |                |                                                            |
 * |----------------|------------------------------------------------------------|
 * |namespace       |http://opcfoundation.org/UA/                                |
 * |nodeClass       |VariableType                                                |
 * |typedDefinition |PropertyType i=68                                           |
 * |dataType        |Null                                                        |
 * |dataType Name   |(VariantOptions | VariantOptions[]) i=0                     |
 * |value rank      |-2                                                          |
 * |isAbstract      |false                                                       |
 */
export interface UAProperty_Base<T, DT extends DataType>  {
}
export interface UAProperty<T, DT extends DataType> extends UAVariableT<T, DT>, UAProperty_Base<T, DT> {
}