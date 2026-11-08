cmake_minimum_required(VERSION 3.21)
project(remote_workspace_rdp_test_server LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
# Needs a FreeRDP prefix built WITH the server side and the drdynvc/disp/cliprdr server channels
# (work/integration-server-20261016/build-freerdp-server.sh); the client prefix used by the bridge is not enough.
find_package(FreeRDP CONFIG REQUIRED)
find_package(FreeRDP-Server CONFIG REQUIRED)
find_package(WinPR CONFIG REQUIRED)
find_package(Threads REQUIRED)
add_executable(rdp-test-server server.cpp)
target_link_libraries(rdp-test-server PRIVATE freerdp freerdp-server winpr Threads::Threads)
if(APPLE)
  set_target_properties(rdp-test-server PROPERTIES BUILD_RPATH "$<TARGET_FILE_DIR:freerdp>;$<TARGET_FILE_DIR:freerdp-server>;$<TARGET_FILE_DIR:winpr>")
endif()
