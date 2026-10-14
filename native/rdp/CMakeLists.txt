cmake_minimum_required(VERSION 3.21)
project(remote_workspace_rdp LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(FreeRDP CONFIG REQUIRED)
find_package(WinPR CONFIG REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads REQUIRED)
if(NOT EXISTS "${JSON_INCLUDE_DIR}/json.hpp")
  message(FATAL_ERROR "JSON_INCLUDE_DIR must contain pinned json.hpp")
endif()
add_executable(rdp-bridge bridge.cpp)
target_include_directories(rdp-bridge PRIVATE "${JSON_INCLUDE_DIR}")
target_link_libraries(rdp-bridge PRIVATE freerdp winpr OpenSSL::Crypto Threads::Threads)
if(APPLE)
  set_target_properties(rdp-bridge PROPERTIES
    BUILD_RPATH "$<TARGET_FILE_DIR:freerdp>;$<TARGET_FILE_DIR:winpr>"
    INSTALL_RPATH "$<TARGET_FILE_DIR:freerdp>;$<TARGET_FILE_DIR:winpr>")
endif()
enable_testing()
add_executable(surface-test surface-test.cpp)
add_test(NAME surface COMMAND surface-test)
add_executable(control-test control-test.cpp)
target_include_directories(control-test PRIVATE "${JSON_INCLUDE_DIR}")
add_test(NAME control COMMAND control-test)
if(WIN32)
  install(TARGETS rdp-bridge RUNTIME_DEPENDENCY_SET bridge_runtime RUNTIME DESTINATION bin)
  install(RUNTIME_DEPENDENCY_SET bridge_runtime
    DIRECTORIES "${FREERDP_RUNTIME_DIR}" "${OPENSSL_ROOT_DIR}/bin"
    PRE_EXCLUDE_REGEXES "api-ms-" "ext-ms-"
    POST_EXCLUDE_REGEXES ".*[\\\\/][Ww][Ii][Nn][Dd][Oo][Ww][Ss][\\\\/].*"
    RUNTIME DESTINATION bin)
else()
  install(TARGETS rdp-bridge RUNTIME DESTINATION bin)
endif()
