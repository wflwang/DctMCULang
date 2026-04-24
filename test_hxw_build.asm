;//@@@HXW inst###

; 测试 HXW 编译功能

mDctUart_Data   macro 
 ;//switch cDctUart_Bps 
 ;//    case 9600 
 ;//    lcall       DELAY_103us 
 ;//    break 
 ;//    case 19200 
 ;//    lcall       DELAY_51us 
 ;//    break 
 ;//    case 38400 
     ;//lcall       DELAY_25us  ;25us/25.5/25.75 
     call        DELAY_10us 
     call        DELAY_10us 
     call        DELAY_5us 
 ;//    break 
 ;//endsw 
 endm 

; 定义延时函数
DELAY_10us:
    nop
    ret

DELAY_5us:
    ret

; 主程序
main:
    mDctUart_Data   ; 调用宏
    goto        main    ; 循环

end
