const fs = require('fs');
const path = require('path');
const core = require('@actions/core');
const github = require('@actions/github');
const ApiGtw = require('./api-gtw');

module.exports = class ApiMerger {

  mergeSwagger(localSwagger, awsSwagger) {
    try {
      console.log("============ SWAGGER (no extension) ====================================================");
      // console.log(JSON.stringify(localSwagger));
      for (var [key, value, jsonpath] of traverse(awsSwagger)) {
        if (key.startsWith('x-amazon')) {
          // We found an extension. Now find the parent object that owns this extension
          const parent = jsonpath.slice(0, -1);

          // We know the parent object and therefore its path in the Swagger object
          // Let's find if this parent object also exists in the Swagger file from JAVA
          // If it's the case, then add the extension to it
          const originalObj = get(localSwagger, parent);
          if (originalObj && !originalObj[key]) {
            originalObj[key] = value;
          }
        }
      }
      console.log("============ SWAGGER (MERGED) ====================================================");
      // console.log(JSON.stringify(localSwagger));
      return localSwagger;

      // Save the merged JSON in a file
      // const swaggerMergedPath = path.join(this.tmpPath, 'merged-swagger.json');
      // fs.writeFileSync(swaggerMergedPath, mergedJson);
      // core.setOutput("merged-swagger-path", swaggerMergedPath);
    } catch (error) {
      core.setFailed(error.message);
    }
  }


  mergeExtensions(localSwagger, apiName, basePath, mediaTypes, additionalHeaders) {
    try {
      const swagger = localSwagger;
      // Backup list of original paths
      const originalPath = {};

      // Rename title in swagger to match apiName (and avoid duplicated api due to mismatch between title and apiName)
      if (swagger.info && swagger.info.title) {
        swagger.info.title = apiName;
      }

      // Add default headers, some of them are AWS specific
      if (additionalHeaders) {
        additionalHeaders += ","
      }
      additionalHeaders += "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token"

      console.log("============ SWAGGER (MERGED but no extension) ====================================================");
      // console.log(JSON.stringify(swagger));

      if (swagger.paths) {
        Object.keys(swagger.paths).forEach(path => {

          // Replace /* and /** by /{proxy+} to allow import by AWS Api Gateway
          if (path.endsWith("/**") || path.endsWith("/*")) {
            let pattern = "";
            path.endsWith("/**") ? pattern = "/**" : pattern = "/*";
            let newPath = path.replace(pattern, "/{proxy+}");
            Object.defineProperty(swagger.paths, newPath, Object.getOwnPropertyDescriptor(swagger.paths, path));
            delete swagger.paths[path];
            path = newPath;
          }

          // Store the original path for later use
          originalPath[path] = path;
          let parametersList = getParamaterFromPath(path);

          Object.keys(swagger.paths[path]).forEach(operation => {

            // Replace */* by application/json in "produces" mime-type (*/* is rejected by AWS Api Gateway)
            if (swagger.paths[path][operation].produces) {
              Object.keys(swagger.paths[path][operation].produces).forEach(production => {
                if (swagger.paths[path][operation].produces[production] === "*/*") {
                  swagger.paths[path][operation].produces[production] = "application/json";
                }
              });
            }

            // Replace $ in the object name for each response code and in parameters
            if (swagger.paths[path][operation].responses) {
              Object.keys(swagger.paths[path][operation].responses).forEach(responseCode => {
                if (swagger.paths[path][operation].responses[responseCode].schema && swagger.paths[path][operation].responses[responseCode].schema["$ref"]) {
                  swagger.paths[path][operation].responses[responseCode].schema["$ref"] = swagger.paths[path][operation].responses[responseCode].schema["$ref"].replace(/\$/g, "");
                }
              });
            }

            if (swagger.paths[path][operation].parameters) {
              Object.keys(swagger.paths[path][operation].parameters).forEach(parameter => {

                // Look for path parameters and change its name to avoid coliding (save the old name)
                if (swagger.paths[path][operation].parameters[parameter].in === "path") {

                  swagger.paths[path][operation].parameters[parameter].integrationName = swagger.paths[path][operation].parameters[parameter].name;
                  swagger.paths[path][operation].parameters[parameter].name = "param" + parametersList[swagger.paths[path][operation].parameters[parameter].name];

                  let newPath = path.replace("{" + swagger.paths[path][operation].parameters[parameter].integrationName + "}", "{" + swagger.paths[path][operation].parameters[parameter].name + "}");
                  if (newPath !== path) {
                    Object.defineProperty(swagger.paths, newPath, Object.getOwnPropertyDescriptor(swagger.paths, path));
                    delete swagger.paths[path];
                  }       

                  // Update path storage because the path is changed (and the old path is needed later)
                  originalPath[newPath] = path;
                  path = newPath;
                }

                if (swagger.paths[path][operation].parameters[parameter].schema && swagger.paths[path][operation].parameters[parameter].schema["$ref"]) {
                  swagger.paths[path][operation].parameters[parameter].schema["$ref"] = swagger.paths[path][operation].parameters[parameter].schema["$ref"].replace(/\$/g, "");
                }
              });
            }

            // Add the integration to the VPC_LINK
            if (!swagger.paths[path][operation]['x-amazon-apigateway-integration']) {

              // Fill the requestParameters attribute if there are some path/query parameters
              let requestParameters = {};
              if (swagger.paths[path][operation].parameters) {
                Object.keys(swagger.paths[path][operation].parameters).forEach(parameter => {
                  let nameParameter = swagger.paths[path][operation].parameters[parameter].name;

                  // Other parameter type exist and can be found here : https://docs.aws.amazon.com/apigateway/latest/developerguide/request-response-data-mappings.html
                  switch (swagger.paths[path][operation].parameters[parameter].in) {
                    // case 'query':
                    //   requestParameters['integration.request.querystring.' + nameParameter] = "method.request.querystring." + nameParameter;
                    //   break;
                    case 'path':
                      requestParameters['integration.request.path.' + swagger.paths[path][operation].parameters[parameter].integrationName] = "method.request.path." + nameParameter;
                      break;
                    case 'header':
                      requestParameters['integration.request.header.' + nameParameter] = "method.request.header." + nameParameter;
                      break;
                  }
                });
              }

              // Replace the end of the path to match AWS Api Gateway convention
              let integrationPath = originalPath[path].replace("/{proxy+}", "/{proxy}");

              swagger.paths[path][operation]['x-amazon-apigateway-integration'] = {
                "uri": "https://${stageVariables.VPCNLB}/" + basePath + integrationPath,
                "responses": {
                  "default": {
                    "statusCode": "200"
                  }
                },
                "requestTemplates": {
                  "application/json": "{\"statusCode\": 200}"
                },
                "requestParameters": requestParameters,
                "passthroughBehavior": "when_no_match",
                "connectionType": "VPC_LINK",
                "connectionId": "${stageVariables.VPCLINK}",
                "httpMethod": operation,
                "type": "http_proxy"
              }
            }

            // Add CORS header for each response code (200,300,400,500,...)
            Object.keys(swagger.paths[path][operation].responses).forEach(responseCode => {
              // Add the header field if needed
              if (!swagger.paths[path][operation].responses[responseCode].headers) {
                swagger.paths[path][operation].responses[responseCode].headers = {};
              }

              // Add the CORS header
              swagger.paths[path][operation].responses[responseCode].headers["Access-Control-Allow-Origin"] = {
                "schema": {
                  "type": "string"
                }
              }
            })
          });

          // Add "OPTIONS" operation if needed
          if (!swagger.paths[path].options) {
            // String with all defined operations, i.e. : GET,OPTIONS,PUT
            let formattedOperations = Object.keys(swagger.paths[path]).sort().join(',').toUpperCase();
            let formattedHeaders = requestParametersHeadersExtension(swagger.paths[path], additionalHeaders)

            swagger.paths[path].options = {
              "responses": {
                "200": {
                  "description": "200 response",
                  "headers": {
                    "Access-Control-Allow-Origin": {
                      "type": "string"
                    },
                    "Access-Control-Allow-Methods": {
                      "type": "string"
                    },
                    "Access-Control-Allow-Headers": {
                      "type": "string"
                    },
                  },
                  "schema": {
                    "$ref": "#/definitions/Empty"
                  }
                }
              },
              "x-amazon-apigateway-integration": {
                "responses": {
                  "default": {
                    "statusCode": "200",
                    "responseParameters": {
                      "method.response.header.Access-Control-Allow-Methods": "'" + formattedOperations + "'",
                      "method.response.header.Access-Control-Allow-Headers": "'" + formattedHeaders + "'",
                      "method.response.header.Access-Control-Allow-Origin": "'*'"
                    }
                  }
                },
                "requestTemplates": {
                  "application/json": "{\"statusCode\": 200}"
                },
                "passthroughBehavior": "when_no_match",
                "type": "mock"
              }
            }
          }
        });
      }

      // Add the "Empty" model required by the operation "OPTIONS" for CORS
      if (swagger.definitions) {
        if (!swagger.definitions['Empty']) {
          swagger.definitions['Empty'] = {
            "title": "Empty Schema",
            "type": "object"
          }
        }
      }

      // Add media-types if given in argument
      if (swagger && mediaTypes.length > 0) {
        swagger['x-amazon-apigateway-binary-media-types'] = mediaTypes;
      }

      // Remove attribut "example" in object description because it is not supported by AWS Api Gateway
      // Remove also the $ in object name
      Object.keys(swagger.definitions).forEach(objectDefinition => {

        if (objectDefinition.includes("$") || objectDefinition.includes("«") || objectDefinition.includes(",") || objectDefinition.includes("»")) {
          let newObjectDefinition = objectDefinition.replace(/\$/g, "").replace(/«/g, "").replace(/,/g, "").replace(/»/g, "");

          // Check duplicated model name
          if (newObjectDefinition in swagger.definitions) {
            throw new Error("Duplicated model name : " + newObjectDefinition);
          }

          // Copy the old object to create a new renamed object, delete the old object
          Object.defineProperty(swagger.definitions, newObjectDefinition, Object.getOwnPropertyDescriptor(swagger.definitions, objectDefinition));
          delete swagger.definitions[objectDefinition];
          objectDefinition = newObjectDefinition;

          if (swagger.definitions[objectDefinition].title) {
            swagger.definitions[objectDefinition].title = swagger.definitions[objectDefinition].title.replace(/\$/g, "").replace(/«/g, "").replace(/,/g, "").replace(/»/g, "");
          }
        }

        if (swagger.definitions[objectDefinition].properties) {
          Object.keys(swagger.definitions[objectDefinition].properties).forEach(property => {

            if (swagger.definitions[objectDefinition].properties[property]["$ref"]) {
              swagger.definitions[objectDefinition].properties[property]["$ref"] = swagger.definitions[objectDefinition].properties[property]["$ref"].replace(/\$/g, "").replace(/«/g, "").replace(/,/g, "").replace(/»/g, "");
            }

            if (swagger.definitions[objectDefinition].properties[property].items && swagger.definitions[objectDefinition].properties[property].items["$ref"]) {
              swagger.definitions[objectDefinition].properties[property].items["$ref"] = swagger.definitions[objectDefinition].properties[property].items["$ref"].replace(/\$/g, "").replace(/«/g, "").replace(/,/g, "").replace(/»/g, "");
            }

            if ("example" in swagger.definitions[objectDefinition].properties[property]) {
              delete swagger.definitions[objectDefinition].properties[property].example;
            }
          });
        }
      });

      console.log("============ SWAGGER (MERGED with extensions) ====================================================");
      const mergedJson = JSON.stringify(swagger);
      console.log(mergedJson);
      return swagger;

      // Save the merged JSON in a file
      // const swaggerMergedPath = path.join(process.cwd(), 'merged-swagger.json');
      // fs.writeFileSync(swaggerMergedPath, mergedJson);
      // core.setOutput("merged-swagger-path", swaggerMergedPath);
    } catch (error) {
      core.setFailed(error.message);
    }
  }
}

function* traverse(o) {
  const memory = new Set();
  function* innerTraversal(o, jsonpath = []) {
    if (memory.has(o)) {
      // we've seen this object before don't iterate it
      return;
    }
    // add the new object to our memory.
    memory.add(o);
    for (var i of Object.keys(o)) {
      const itemPath = jsonpath.concat(i);
      yield [i, o[i], itemPath];
      if (o[i] !== null && typeof (o[i]) == "object") {
        //going one step down in the object tree!!
        yield* innerTraversal(o[i], itemPath);
      }
    }
  }

  yield* innerTraversal(o);
}

function get(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    obj = obj[keys[i]];
    if (!obj) return null;
  }
  return obj;
}

// Format a string in pascal-kebab case
function formatHeader(parameterName) {

  const nameParts = parameterName.split("-");
  let headerFormated = "";

  for (let i = 0; i < nameParts.length; i++) {
    if (headerFormated === "")
      headerFormated = nameParts[i].charAt(0).toUpperCase() + nameParts[i].slice(1);
    else
      headerFormated += "-" + nameParts[i].charAt(0).toUpperCase() + nameParts[i].slice(1);
  }

  return headerFormated;
}

// Retrieve all headers of a given path and contact them
function requestParametersHeadersExtension(paths, defaultHeaders) {

  let headerList = defaultHeaders;

  if (paths) {

    Object.keys(paths).forEach(element => {

      if (paths[element].parameters !== undefined) {

        paths[element].parameters.forEach((parameter) => {

          const nameParameter = parameter.name;

          if (parameter.in === 'header') {
            const headerFormated = formatHeader(nameParameter);
            headerList += "," + headerFormated;
          }
        });
      }
    });
  }
  return headerList;
};

// Return an object with the parameters (delimited by { } in the path) and their order 
// (because the list of parameters in the object "parameters" is ordered by name and not by position)
function getParamaterFromPath(path) {
  let splittedPath = path.split("/");
  let parametersList = {};
  let index = 0;

  splittedPath.forEach(element => {
    if(element.startsWith("{")) {
      // Remove { } from the element
      parametersList[element.slice(1,-1)] = index;
      index++;
    }
  });

  return parametersList;
}
